/** FAQPage JSON-LD. `items` must be the same `{ q, a }` pairs rendered on the page. */
export function faqPageJsonLd(items) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: {
        "@type": "Answer",
        text: a
      }
    }))
  };
}
