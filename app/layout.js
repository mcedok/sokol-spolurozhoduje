import "./globals.css";

export const metadata = {
  title: "Sokol spolurozhoduje",
  description: "Participativní připomínkování sokolských norem",
};

export default function RootLayout({ children }) {
  return (
    <html lang="cs">
      <body>{children}</body>
    </html>
  );
}
