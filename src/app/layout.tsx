import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getSiteConfig } from "@/data/site-config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const config = getSiteConfig();
const title = "AnPPT · AI 生成 PPT，支持转可编辑";
const description =
  "导入 PDF、Word、Markdown 或逐页文案，AI 生成整套设计级 PPT；支持 PPT 美化、图片版导出与转可编辑 PPTX。";

export const metadata: Metadata = {
  metadataBase: new URL(config.publicBaseUrl),
  title: {
    default: title,
    template: "%s | AnPPT",
  },
  description,
  keywords: [
    "AI PPT",
    "PPT 生成",
    "文档转 PPT",
    "PPT 美化",
    "可编辑 PPT",
    "PPT 模板",
    "AnPPT",
  ],
  authors: [{ name: config.companyName }],
  creator: config.companyName,
  publisher: config.companyName,
  category: "productivity",
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: "/",
    siteName: "AnPPT",
    title,
    description,
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: [{ url: "/icon.png", sizes: "512x512", type: "image/png" }],
    shortcut: "/favicon.ico",
    apple: "/icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "AnPPT",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false, email: false, address: false },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f2571a",
  colorScheme: "light",
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${config.publicBaseUrl}/#organization`,
      name: config.companyName,
      url: config.publicBaseUrl,
      logo: `${config.publicBaseUrl}/icon.png`,
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: config.serviceEmail,
        availableLanguage: ["zh-CN"],
      },
    },
    {
      "@type": "WebSite",
      "@id": `${config.publicBaseUrl}/#website`,
      url: config.publicBaseUrl,
      name: "AnPPT",
      description,
      publisher: { "@id": `${config.publicBaseUrl}/#organization` },
      inLanguage: "zh-CN",
    },
    {
      "@type": "SoftwareApplication",
      name: "AnPPT",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: config.publicBaseUrl,
      description,
      publisher: { "@id": `${config.publicBaseUrl}/#organization` },
    },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      data-scroll-behavior="smooth"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
          }}
        />
        {children}
      </body>
    </html>
  );
}
