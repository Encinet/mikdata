declare module '*.wasm' {
  const wasm: WebAssembly.Module | string;
  export default wasm;
}
