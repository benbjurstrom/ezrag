// src/mcp/server.ts - MCP server implementation (Streamable HTTP transport)

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { App } from "obsidian";
import { StateManager } from "../state/state";
import { GeminiService } from "../gemini/geminiService";
import { keywordSearch } from "./tools/keywordSearch";
import { semanticSearch } from "./tools/semanticSearch";
import { readNoteResource, listNoteResources } from "./resources/noteResource";
import express from "express";
import { z } from "zod";

export interface MCPServerOptions {
  app: App;
  stateManager: StateManager;
  getGeminiService: () => GeminiService | null;
  port: number;
}

export class MCPServer {
  private mcpServer: McpServer;
  private httpServer: any = null;
  private expressApp: express.Application;
  private app: App;
  private stateManager: StateManager;
  private getGeminiService: () => GeminiService | null;
  private port: number;
  private isRunning = false;

  constructor(options: MCPServerOptions) {
    this.app = options.app;
    this.stateManager = options.stateManager;
    this.getGeminiService = options.getGeminiService;
    this.port = options.port;

    // Create Express app
    this.expressApp = express();
    this.expressApp.use(express.json());

    // Create MCP server with modern API
    this.mcpServer = new McpServer({
      name: "ezrag-obsidian",
      version: "1.0.0",
    });

    this.setupToolsAndResources();
    this.setupExpressEndpoint();
  }

  private setupToolsAndResources(): void {
    // Register keywordSearch tool
    this.mcpServer.registerTool(
      "keywordSearch",
      {
        title: "Keyword Search",
        description: `Search "${this.app.vault.getName()}" Obsidian vault for keyword matches. Returns file paths and matching lines with context.`,
        inputSchema: {
          query: z.string().describe("Search query (can be a regex pattern)"),
          caseSensitive: z
            .boolean()
            .optional()
            .default(false)
            .describe("Whether to perform case-sensitive search"),
          includeFolders: z
            .array(z.string())
            .optional()
            .default([])
            .describe("Optional array of folder paths to search within"),
        },
        outputSchema: {
          results: z.array(
            z.object({
              path: z.string(),
              matches: z.array(
                z.object({
                  line: z.number(),
                  text: z.string(),
                  before: z.string(),
                  after: z.string(),
                }),
              ),
            }),
          ),
        },
      },
      async ({ query, caseSensitive, includeFolders }) => {
        try {
          const results = await keywordSearch(this.app, {
            query,
            caseSensitive,
            includeFolders,
          });

          const output = { results };
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(output, null, 2),
              },
            ],
            structuredContent: output as Record<string, unknown>,
          };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          throw new Error(`Keyword search failed: ${errorMessage}`);
        }
      },
    );

    // Register semanticSearch tool
    this.mcpServer.registerTool(
      "semanticSearch",
      {
        title: "Semantic Search",
        description: `Search the user's "${this.app.vault.getName()}" Obsidian vault to answer questions based on their personal notes. Pass the user's question or topic directly - the query will be grounded in their documents automatically. Returns an AI-generated answer with inline citations referencing specific notes. Use this when users ask about their own ideas, projects, notes, or any information they may have documented.`,
        inputSchema: {
          query: z.string().describe("The user's question or topic to search for in their notes"),
          model: z
            .enum(["gemini-2.5-flash", "gemini-2.5-pro"])
            .optional()
            .default("gemini-2.5-flash")
            .describe("Gemini model to use"),
        },
        outputSchema: {
          answer: z.string(),
        },
      },
      async ({ query, model }) => {
        const geminiService = this.getGeminiService();
        if (!geminiService) {
          throw new Error(
            "Gemini service not available. Please configure your API key in settings.",
          );
        }

        const storeName = this.stateManager.getSettings().storeName;
        if (!storeName) {
          throw new Error(
            "No FileSearch store configured. Please index some notes first.",
          );
        }

        try {
          const markdown = await semanticSearch(geminiService, storeName, {
            query,
            model,
          });

          return {
            content: [{ type: "text", text: markdown }],
            structuredContent: { answer: markdown } as Record<string, unknown>,
          };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          throw new Error(`Semantic search failed: ${errorMessage}`);
        }
      },
    );

    // Register note resource with dynamic URI template
    this.mcpServer.registerResource(
      "note",
      new ResourceTemplate("note:///{path}", {
        list: () => {
          const includeFolders = this.stateManager.getSettings().includeFolders;
          const uris = listNoteResources(this.app, includeFolders);
          return {
            resources: uris.map((uri) => ({
              name: uri.replace(/^note:\/\/\//, ""),
              uri,
              mimeType: "text/markdown",
            })),
          };
        },
      }),
      {
        title: "Note Content",
        description: "Read note content and metadata by vault path",
        mimeType: "text/markdown",
      },
      async (uri, { path }) => {
        try {
          const content = await readNoteResource(
            this.app,
            this.stateManager,
            uri.href,
          );
          return {
            contents: [
              {
                uri: content.uri,
                mimeType: content.mimeType,
                text: content.text,
              },
            ],
          };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to read note: ${errorMessage}`);
        }
      },
    );
  }

  private setupExpressEndpoint(): void {
    // Modern Streamable HTTP endpoint (stateless mode)
    this.expressApp.post(
      "/mcp",
      async (req: express.Request, res: express.Response) => {
        try {
          // Create new transport for each request (prevents request ID collisions)
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Stateless mode
            enableJsonResponse: true,
          });

          // Cleanup transport when response closes
          res.on("close", () => {
            transport.close();
          });

          // Connect server to transport
          await this.mcpServer.connect(transport);

          // Handle the request
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error("[MCP Server] Error handling request:", error);
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: "2.0",
              error: {
                code: -32603,
                message: "Internal server error",
              },
              id: null,
            });
          }
        }
      },
    );

    // Health check endpoint
    this.expressApp.get(
      "/health",
      (req: express.Request, res: express.Response) => {
        res.json({
          status: "ok",
          server: "ezrag-obsidian-mcp",
          version: "1.0.0",
        });
      },
    );
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        this.httpServer = this.expressApp.listen(this.port, () => {
          this.isRunning = true;
          resolve();
        });

        this.httpServer.on("error", (err: any) => {
          console.error("[MCP Server] HTTP server error:", err);
          this.isRunning = false;
          reject(err);
        });
      } catch (err) {
        console.error("[MCP Server] Failed to start:", err);
        reject(err);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          this.isRunning = false;
          this.httpServer = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getStatus(): { running: boolean; url: string } {
    return {
      running: this.isRunning,
      url: this.isRunning ? `http://localhost:${this.port}/mcp` : "",
    };
  }
}
