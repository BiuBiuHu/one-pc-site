import { personNode } from "../data/site.js";

/** Service JSON-LD for the offerings listed on /services/. No fake offers or ratings. */
export function servicesPageJsonLd({ services, pageUrl, providerUrl }) {
  return {
    "@context": "https://schema.org",
    "@graph": services.map((service) => {
      const url = serviceUrl(service, pageUrl);
      return {
        "@type": "Service",
        name: service.name,
        description: service.summary,
        serviceType: service.name,
        url,
        provider: personNode({ url: providerUrl })
      };
    })
  };
}

function serviceUrl(service, pageUrl) {
  const href = service.cta?.href;
  if (href && /^https?:\/\//.test(href)) return href;
  return pageUrl;
}
