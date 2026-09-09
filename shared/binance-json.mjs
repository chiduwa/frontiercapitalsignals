// Binance emits identifiers as JSON numbers even when their values exceed
// JavaScript's exact integer range. Preserve every unsafe integer token before
// JSON.parse can round it. Existing strings and exactly representable numbers
// retain their normal JSON types.
export function parseBinanceJson(text) {
  if (typeof text !== 'string') throw new TypeError('Binance response body must be text');
  let transformed = '';
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  for (let cursor = 0; cursor < text.length;) {
    if (text[cursor] === '"') {
      const tokenStart = cursor;
      cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        cursor += 1;
        if (text[cursor - 1] === '"') break;
      }
      transformed += text.slice(tokenStart, cursor);
      continue;
    }

    const character = text[cursor];
    if (character === '-' || (character >= '0' && character <= '9')) {
      numberPattern.lastIndex = cursor;
      const number = numberPattern.exec(text)?.[0];
      if (number) {
        const unsafeInteger = !/[.eE]/.test(number)
          && !Number.isSafeInteger(Number(number));
        transformed += unsafeInteger ? `"${number}"` : number;
        cursor += number.length;
        continue;
      }
    }

    transformed += text[cursor];
    cursor += 1;
  }
  return JSON.parse(transformed);
}
