import type { Metadata } from "next";
import "./globals.css";
import { SolanaProvider } from "@/components/SolanaProvider";

export const metadata: Metadata = {
  title: "StockSpend",
  description: "Spend your tokenized stock portfolio without selling it",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <SolanaProvider>{children}</SolanaProvider>
      </body>
    </html>
  );
}
