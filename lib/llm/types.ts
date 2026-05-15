export interface ChatRequest {
  messages: {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
    name?: string;
  }[];
  tools?: {
    type: 'function';
    function: { name: string; description: string; parameters: object };
  }[];
  stream?: boolean;
}

export interface ChatResponse {
  content: string;
  tool_calls?: { id: string; name: string; arguments: Record<string, unknown> }[];
}

export type ProviderFn = (req: ChatRequest) => Promise<ChatResponse>;
