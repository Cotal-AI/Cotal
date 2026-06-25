// qr-cotal.mjs — pre-generated QR code for the Cotal website, for the live-event signage
// (the terminal brand banner and the browser wall both render this single matrix).
//
// Static on purpose: no runtime QR encoder, no dependency. `MATRIX[y][x] === '1'` is a dark
// module. This is a 25×25 (version 2, error-correction level M) symbol encoding COTAL_URL;
// it has been decode-verified to read back as https://cotal.ai.
//
// To regenerate if the URL ever changes, fetch a QR for the new URL and read one dark module
// per `M x,y l 12,0 0,12` path command (col = x/12, row = y/12) into a square grid, e.g.:
//   curl -s 'https://api.qrserver.com/v1/create-qr-code/?data=<urlencoded>&format=svg&qzone=0&ecc=M'

export const COTAL_URL = 'https://cotal.ai';

// 1 = dark module, 0 = light. Quiet zone is added by the renderers, not stored here.
export const MATRIX = [
  '1111111001110001101111111',
  '1000001000101000001000001',
  '1011101011001010101011101',
  '1011101010111000001011101',
  '1011101011111111001011101',
  '1000001010110111101000001',
  '1111111010101010101111111',
  '0000000011100101000000000',
  '1011111000110010001111100',
  '0011100011111000100100010',
  '0011101110100001110111011',
  '1101100000010011010000001',
  '1101111000100001011010111',
  '1000110101101110110101010',
  '1000101100000111011111011',
  '1001110110001100101110001',
  '1000011000001010111110100',
  '0000000010000001100011000',
  '1111111001011000101010111',
  '1000001011010011100011001',
  '1011101010010001111110101',
  '1011101010101111011011111',
  '1011101010000110100001101',
  '1000001000001101101111001',
  '1111111010001010011111111',
];
