/**
 * Polyfills for newer JS APIs that may be missing in older browsers.
 * pdfjs-dist v5 uses `Uint8Array.prototype.toHex` (ES2024, Chrome 134+).
 * Without this polyfill, PDF document fingerprint computation throws
 * "n.toHex is not a function" and breaks the whole pipeline.
 */
type Uint8ArrayHexAware = Uint8Array & {
  toHex?: () => string;
  toBase64?: (opts?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }) => string;
};

const HEX = "0123456789abcdef";

export function installPolyfills(): void {
  const proto = Uint8Array.prototype as unknown as Uint8ArrayHexAware;
  if (typeof proto.toHex !== "function") {
    Object.defineProperty(Uint8Array.prototype, "toHex", {
      value: function toHex(this: Uint8Array): string {
        let out = "";
        for (let i = 0; i < this.length; i++) {
          const b = this[i];
          out += HEX[(b >>> 4) & 0xf] + HEX[b & 0xf];
        }
        return out;
      },
      writable: true,
      configurable: true,
    });
  }
  if (typeof proto.toBase64 !== "function") {
    Object.defineProperty(Uint8Array.prototype, "toBase64", {
      value: function toBase64(this: Uint8Array): string {
        let bin = "";
        for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]);
        return btoa(bin);
      },
      writable: true,
      configurable: true,
    });
  }
}
