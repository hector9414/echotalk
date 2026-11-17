// Minimal ambient typing for the 'selfsigned' package (it ships no types of
// its own) - just the surface this project actually calls.
declare module 'selfsigned' {
  export interface GenerateOptions {
    days?: number;
    keySize?: number;
    algorithm?: string;
    extensions?: Array<Record<string, unknown>>;
  }

  export interface GenerateResult {
    private: string;
    public: string;
    cert: string;
    fingerprint: string;
  }

  export function generate(
    attrs?: Array<{ name: string; value: string }>,
    options?: GenerateOptions,
  ): GenerateResult;
}
