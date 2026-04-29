import QRCode from "qrcode";

/** Generate QR code data URL for a phone-join URL. */
export async function makeQrDataUrl(text: string, size = 256): Promise<string> {
  return QRCode.toDataURL(text, {
    width: size,
    margin: 1,
    color: { dark: "#0a0a0f", light: "#ffffff" },
  });
}

/** Build phone-join URL from a base origin + room id. */
export function buildPhoneUrl(origin: string, roomId: string): string {
  return `${origin.replace(/\/+$/, "")}/m/${roomId}`;
}
