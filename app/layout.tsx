import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Motivation Engine — Control Center",
  description:
    "Ventora's knowledge layer: an ontology of human motivation mechanisms.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
