import "./globals.css";

export const metadata = {
  title: "Sokol spolurozhoduje",
  description: "Participativní připomínkování sokolských norem",
};

export default function RootLayout({ children }) {
  return (
    <html lang="cs">
      <head>
        <link rel="icon" href="/brand/sokol-symbol.png" type="image/png" />
      </head>
      <body>{children}</body>
    </html>
  );
}
