export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Frontier Capital Signals",
  url: "https://frontiercapitalsignals.com",
  logo: "https://frontiercapitalsignals.com/logo.png",
  description:
    "AI-powered investment intelligence for Ghana, Nigeria, Kenya, Malawi, and Uganda. Daily market insights, due diligence support, and on-ground intelligence for emerging market investors.",
  sameAs: [],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    url: "https://frontiercapitalsignals.com/contact",
  },
  areaServed: [
    { "@type": "Country", name: "Ghana" },
    { "@type": "Country", name: "Nigeria" },
    { "@type": "Country", name: "Kenya" },
    { "@type": "Country", name: "Malawi" },
    { "@type": "Country", name: "Uganda" },
  ],
};

export const websiteSchema = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Frontier Capital Signals",
  url: "https://frontiercapitalsignals.com",
  description: "AI-powered emerging market investment intelligence for Africa.",
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: "https://frontiercapitalsignals.com/intelligence?q={search_term_string}",
    },
    "query-input": "required name=search_term_string",
  },
};

export function articleSchema({
  title,
  summary,
  date,
  slug,
  country,
  category,
}: {
  title: string;
  summary: string;
  date: string;
  slug: string;
  country: string;
  category: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description: summary,
    datePublished: date,
    dateModified: date,
    url: `https://frontiercapitalsignals.com/intelligence/${slug}`,
    author: {
      "@type": "Organization",
      name: "Frontier Capital Signals",
      url: "https://frontiercapitalsignals.com",
    },
    publisher: {
      "@type": "Organization",
      name: "Frontier Capital Signals",
      logo: {
        "@type": "ImageObject",
        url: "https://frontiercapitalsignals.com/logo.png",
      },
    },
    about: [
      { "@type": "Thing", name: country },
      { "@type": "Thing", name: category },
      { "@type": "Thing", name: "African Investment" },
      { "@type": "Thing", name: "Emerging Markets" },
    ],
    keywords: `${country} investment, Africa ${category.toLowerCase()}, frontier markets, ${country} economy`,
    inLanguage: "en-US",
    isAccessibleForFree: true,
  };
}
