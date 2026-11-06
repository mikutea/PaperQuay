const assert = require('node:assert/strict');
const katex = require(process.argv[2]);

// Model a pre-existing prototype pollution without contaminating the test runner.
// The upstream advisory is conditional; KaTeX is not itself the pollution source.
Object.prototype.trust = true;
try {
  for (const options of [{ throwOnError: false }, { throwOnError: false, trust: false }]) {
    for (const latex of [
      String.raw`\href{javascript:alert(1)}{link}`,
      String.raw`\htmlClass{prototype-owned}{x}`,
      String.raw`\includegraphics{https://fixture.invalid/tracking.png}`,
    ]) {
      const html = katex.renderToString(latex, options);
      assert.doesNotMatch(html, /<a[\s>]|<img[\s>]|class="[^"]*\bprototype-owned\b/i);
    }
    const math = katex.renderToString(String.raw`\frac{a_1}{b^2}`, options);
    assert.match(math, /<mfrac>/);
    assert.doesNotMatch(math, /katex-error/);
  }
} finally {
  delete Object.prototype.trust;
}
