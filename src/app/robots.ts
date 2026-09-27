import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/faq", "/apply"],
        disallow: ["/dashboard", "/operator", "/onboarding", "/api"],
      },
    ],
  };
}
