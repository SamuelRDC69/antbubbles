import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "AntBubbles — WAX Token Visualizer",
  description: "Real-time bubble chart for WAX tokens. Track price changes, volume, and market cap powered by Alcor DEX.",
  openGraph: {
    title:       "AntBubbles — WAX Token Visualizer",
    description: "Real-time bubble chart for WAX tokens. Track price changes, volume, and market cap powered by Alcor DEX.",
    url:         "https://bubbles.wax-pepe.vip",
    siteName:    "AntBubbles",
    type:        "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "AntBubbles" }],
  },
  twitter: {
    card:        "summary_large_image",
    title:       "AntBubbles — WAX Token Visualizer",
    description: "Real-time bubble chart for WAX tokens powered by Alcor DEX.",
    images:      ["/og.png"],
  },
  metadataBase: new URL("https://bubbles.wax-pepe.vip"),
  alternates: { canonical: "/" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <head>
        {/* Pre-establish connection to Alcor WAX API */}
        <link rel="preconnect" href="https://wax.alcor.exchange" />
      </head>
      <body className="h-full bg-black overflow-hidden">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
