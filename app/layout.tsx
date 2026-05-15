import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FORGE",
  description: "Forecast-driven Operational Risk Governance Engine",
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
