import { globalFetch } from "src/ts/globalApi.svelte";
import { getDatabase } from "src/ts/storage/database.svelte";
import { contextHash, type VectorArray } from "./hypamemory";

export interface ContextualEmbeddingProvider {
  readonly modelId: string;
  embedDocumentGroups(groups: string[][]): Promise<VectorArray[][]>;
  embedQueries(queries: string[]): Promise<VectorArray[]>;
  getCacheKeySuffix(contextTexts?: string[]): string;
}

export function isContextModel(model: string): boolean {
  return model === 'voyageContext3';
}

export function getContextProvider(model: string): ContextualEmbeddingProvider | null {
  switch (model) {
    case 'voyageContext3':
      return new VoyageContext3Provider();
    default:
      return null;
  }
}

const VOYAGE_API_URL = "https://api.voyageai.com/v1/contextualizedembeddings";
const VOYAGE_MODEL = "voyage-context-3";
const MAX_CHUNKS_PER_REQUEST = 16000;
const MAX_INPUTS_PER_REQUEST = 1000;
// Per-chunk: Voyage allows ~32k tokens. 42000 chars stays safely under that.
const VOYAGE_MAX_CHARS = 42000;
// Per-batch (sum across all chunks in one request): Voyage hard cap is 120k tokens.
// Empirically observed: chars/3 estimate undercounted Korean content by ~1.4x
// (100k estimated → 141k actual). Use chars/2 (CJK-realistic) and an 80k budget
// for safety margin against tokenizer variance.
const VOYAGE_MAX_BATCH_TOKENS_EST = 80_000;
const CHARS_PER_TOKEN_EST = 2;

function truncateForVoyage(text: string): string {
    return text.length > VOYAGE_MAX_CHARS ? text.slice(0, VOYAGE_MAX_CHARS) : text;
}

function estimateTokens(group: string[]): number {
    let chars = 0;
    for (const c of group) chars += c.length;
    return Math.ceil(chars / CHARS_PER_TOKEN_EST);
}

class VoyageContext3Provider implements ContextualEmbeddingProvider {
  readonly modelId = VOYAGE_MODEL;

  private getApiKey(): string {
    const db = getDatabase();
    const apiKey = db.voyageApiKey?.trim();
    if (!apiKey) {
      throw new Error('Voyage Context 3 requires a Voyage API Key');
    }
    return apiKey;
  }

  async embedDocumentGroups(groups: string[][]): Promise<VectorArray[][]> {
    const apiKey = this.getApiKey();
    // Truncate per-chunk to Voyage's token limit before batching
    const truncatedGroups = groups.map(g => g.map(truncateForVoyage));
    const batches = this.batchGroups(truncatedGroups);
    const allResults: VectorArray[][] = new Array(truncatedGroups.length);

    let groupOffset = 0;
    for (const batch of batches) {
      const response = await globalFetch(VOYAGE_API_URL, {
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json"
        },
        body: {
          "model": VOYAGE_MODEL,
          "inputs": batch,
          "input_type": "document"
        }
      });

      if (!response.ok || !response.data.data) {
        throw new Error(JSON.stringify(response.data));
      }

      for (let i = 0; i < batch.length; i++) {
        const groupEmbeddings: VectorArray[] = response.data.data[i].data.map(
          (item: { embedding: VectorArray }) => item.embedding
        );
        allResults[groupOffset + i] = groupEmbeddings;
      }

      groupOffset += batch.length;
    }

    return allResults;
  }

  async embedQueries(queries: string[]): Promise<VectorArray[]> {
    const apiKey = this.getApiKey();
    const truncated = queries.map(truncateForVoyage);
    // Each query is its own one-element group for the API; reuse the
    // document-batching helper to enforce the 120k token-per-batch cap.
    const queryGroups = truncated.map(t => [t]);
    const batches = this.batchGroups(queryGroups);
    const out: VectorArray[] = new Array(truncated.length);

    let offset = 0;
    for (const batch of batches) {
      const response = await globalFetch(VOYAGE_API_URL, {
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json"
        },
        body: {
          "inputs": batch,
          "model": VOYAGE_MODEL,
          "input_type": "query"
        }
      });

      if (!response.ok || !response.data.data) {
        throw new Error(JSON.stringify(response.data));
      }

      for (let i = 0; i < batch.length; i++) {
        out[offset + i] = response.data.data[i].data[0].embedding;
      }
      offset += batch.length;
    }

    return out;
  }

  getCacheKeySuffix(contextTexts?: string[]): string {
    const ctxPart = contextTexts && contextTexts.length > 1
      ? `|ctx:${contextHash(contextTexts)}`
      : '';
    return `|voyageContext3${ctxPart}`;
  }

  private batchGroups(groups: string[][]): string[][][] {
    const batches: string[][][] = [];
    let currentBatch: string[][] = [];
    let currentChunkCount = 0;
    let currentTokenEst = 0;

    for (const group of groups) {
      const groupTokens = estimateTokens(group);
      if (
        currentBatch.length > 0 &&
        (currentBatch.length + 1 > MAX_INPUTS_PER_REQUEST ||
         currentChunkCount + group.length > MAX_CHUNKS_PER_REQUEST ||
         currentTokenEst + groupTokens > VOYAGE_MAX_BATCH_TOKENS_EST)
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChunkCount = 0;
        currentTokenEst = 0;
      }
      currentBatch.push(group);
      currentChunkCount += group.length;
      currentTokenEst += groupTokens;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }
}
