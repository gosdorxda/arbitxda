import type { Metadata } from "next";
import {
  Fira_Code,
  Geist,
  Geist_Mono,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  Inter,
  JetBrains_Mono,
  Plus_Jakarta_Sans,
} from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const ibmPlexSans = IBM_Plex_Sans({
  variable: "--font-ibm-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plusJakarta = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta",
  subsets: ["latin"],
});

const firaCode = Fira_Code({
  variable: "--font-fira-code",
  subsets: ["latin"],
});

const fontVariables = [
  geistSans.variable,
  geistMono.variable,
  inter.variable,
  jetbrainsMono.variable,
  ibmPlexSans.variable,
  ibmPlexMono.variable,
  plusJakarta.variable,
  firaCode.variable,
].join(" ");

export const metadata: Metadata = {
  title: "Arbit Scanner",
  description: "Perbandingan harga spot USD/USDT antar exchange, dari hasil fetch ke database.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="id"
      className={`${fontVariables} h-full antialiased`}
      data-font="geist"
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var t=localStorage.getItem("arbit-theme");if(t==="light"){document.documentElement.setAttribute("data-theme","light");document.documentElement.classList.add("light");}else{document.documentElement.setAttribute("data-theme","dark");document.documentElement.classList.remove("light");}var f=localStorage.getItem("arbit-font");var ok={geist:1,inter:1,"ibm-plex":1,jakarta:1};document.documentElement.setAttribute("data-font",ok[f]?f:"geist");}catch(e){}})();',
          }}
        />
      </head>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">{children}</body>
    </html>
  );
}
