// Allow importing .css files as plain text strings (handled by esbuild loader).
declare module "*.css" {
  const content: string;
  export default content;
}
