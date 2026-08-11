import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { BackgroundFX } from "@/components/BackgroundFX";
import { NavBar } from "@/components/NavBar";
import { Footer } from "@/components/Footer";
import { ScrollProgress } from "@/components/ScrollProgress";
import { BackToTop } from "@/components/BackToTop";
import { SITE, SITE_URL, VERSION_LABEL } from "@/lib/site";
import { PRODUCT } from "@/lib/product";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

const title = `main — ${SITE.tagline}`;

export const metadata: Metadata = {
  // Everything relative (canonical, OG image, icons) resolves against the real
  // deployed origin instead of the old placeholder "main.app".
  metadataBase: new URL(SITE_URL),
  title: {
    default: title,
    template: "%s · main",
  },
  description: SITE.description,
  applicationName: "main",
  authors: [{ name: SITE.author }],
  creator: SITE.author,
  keywords: [
    "main",
    "desktop overlay",
    "glassmorphism",
    "Windows overlay",
    "gaming overlay",
    "Spotify overlay",
    "synced lyrics",
    "FPS optimizer",
    "quick launch",
    "mini widgets",
    "system monitor",
  ],
  alternates: { canonical: "/" },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "main",
    title,
    description: SITE.description,
  },
  twitter: {
    card: "summary_large_image",
    title,
    description: SITE.description,
  },
  category: "technology",
};

export const viewport: Viewport = {
  themeColor: "#080808",
  colorScheme: "dark",
};

// Structured data so search engines render a rich "app" result (price, OS,
// rating slot) instead of a plain blue link — one of the details AIs skip.
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "main",
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Windows 10, Windows 11",
  softwareVersion: SITE.version,
  description: SITE.description,
  url: SITE_URL,
  image: `${SITE_URL}/opengraph-image`,
  author: { "@type": "Person", name: SITE.author },
  offers: {
    "@type": "Offer",
    price: PRODUCT.priceValue,
    priceCurrency: PRODUCT.currency,
    availability: "https://schema.org/InStock",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${jetbrains.variable}`}
      style={{ fontFamily: "var(--font-inter)" }}
    >
      <head>
        {/* Font Awesome is self-hosted from /public (copied from the
            @fortawesome/fontawesome-free package). It's loaded via <link>
            rather than a node_modules CSS import on purpose: importing the
            scoped package's CSS makes Next emit a "@fortawesome" vendor chunk
            its fallback _document.js can't resolve on `next start`, which 500s
            every unmatched route instead of serving not-found. */}
        <link rel="stylesheet" href="/fontawesome/css/all.min.css" />
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="min-h-screen bg-ink text-white antialiased">
        {/* Keyboard/screen-reader users can jump straight past the nav. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-xl focus:border focus:border-white/20 focus:bg-black/90 focus:px-4 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to content
        </a>
        <Providers>
          <ScrollProgress />
          <BackgroundFX />
          <NavBar />
          <div className="relative z-10 flex min-h-screen flex-col">
            <main id="main-content" className="flex-1">
              {children}
            </main>
            <Footer />
          </div>
          <BackToTop />
        </Providers>
      </body>
    </html>
  );
}
