export interface Env {
  BUILDINGS_KV: KVNamespace;
  BUILDINGS_WRITER: DurableObjectNamespace;
  VPC_SERVICE: Fetcher;
  MINECRAFT_SERVER_URL: string;
  MINECRAFT_SERVER_ADDRESS: string;
  MINECRAFT_SERVER_PORT: string;
  CLOUDFLARE_ACCESS_ISSUER: string;
  CLOUDFLARE_ACCESS_AUD: string;
}
