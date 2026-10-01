// pdfjs-dist 3.x's own type declarations aren't reliably resolved under
// this project's TypeScript module resolution setting, which turns a
// missing-declaration warning into a hard build failure on Vercel. This
// ambient shim covers only what QuoteBuilder.tsx actually uses, so the
// build always has real (if minimal) types instead of failing outright.
declare module "pdfjs-dist" {
  export const GlobalWorkerOptions: { workerSrc: string };
  export const version: string;

  export interface PDFPageProxy {
    getViewport(params: { scale: number }): { width: number; height: number };
    render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
    cleanup(): void;
  }

  export interface PDFDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PDFPageProxy>;
  }

  export function getDocument(params: { data: ArrayBuffer }): { promise: Promise<PDFDocumentProxy> };
}
