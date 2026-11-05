// Vite `?raw` imports (file contents as a string), used by tests only.
declare module "*?raw" {
  const text: string;
  export default text;
}
