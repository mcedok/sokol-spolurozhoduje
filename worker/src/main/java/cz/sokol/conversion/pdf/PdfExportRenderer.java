package cz.sokol.conversion.pdf;

import java.awt.Color;
import java.awt.color.ColorSpace;
import java.awt.color.ICC_Profile;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDMetadata;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.color.PDOutputIntent;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.destination.PDPageFitDestination;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.outline.PDDocumentOutline;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineItem;

public final class PdfExportRenderer {
  private static final float WIDTH = PDRectangle.A4.getWidth();
  private static final float HEIGHT = PDRectangle.A4.getHeight();
  private static final float LEFT = 52;
  private static final float RIGHT = 52;
  private static final float TOP = 62;
  private static final float BOTTOM = 55;
  private static final Color RED = new Color(196, 28, 42);
  private static final Color DARK = new Color(35, 38, 43);
  private static final Color MUTED = new Color(92, 99, 109);
  private static final Color LIGHT = new Color(242, 243, 245);

  private final Path fontRoot;

  public PdfExportRenderer(Path fontRoot) {
    this.fontRoot = fontRoot.toAbsolutePath().normalize();
  }

  public void render(PdfExportSnapshot snapshot, Path output) throws IOException {
    if (snapshot == null) throw new IllegalArgumentException("Snapshot je povinný.");
    Path target = output.toAbsolutePath().normalize();
    Files.createDirectories(target.getParent());
    try (PDDocument pdf = new PDDocument()) {
      pdf.setVersion(1.7f);
      Fonts fonts = loadFonts(pdf);
      PDDocumentOutline outline = new PDDocumentOutline();
      pdf.getDocumentCatalog().setDocumentOutline(outline);
      PDPage title = titlePage(pdf, fonts, snapshot);
      outline(outline, "Titulní strana", title);
      Flow flow = new Flow(pdf, fonts, snapshot);
      PDPage summary = flow.newPage("Souhrn");
      outline(outline, "Souhrn", summary);
      flow.heading("Přehled připomínek", 23);
      flow.paragraph("Dokument " + snapshot.document().number() + " · verze "
+          + snapshot.document().versionNumber(), 10.5f, MUTED, 9);
      flow.statistics(snapshot.statistics());
      flow.heading("Důvodová zpráva", 15);
      flow.paragraph(snapshot.document().explanatoryReport(), 10.5f, DARK, 14);
      flow.heading("Seznam připomínek", 17);
      PDPage commentsPage = flow.page();
      for (PdfExportSnapshot.Comment comment : snapshot.comments()) flow.comment(comment);
      outline(outline, "Připomínky", commentsPage);
      flow.close();
      pageNumbers(pdf, fonts, snapshot);
      metadata(pdf, snapshot);
      pdfaMetadata(pdf, snapshot);
      outline.openNode();
      pdf.save(target.toFile());
    }
  }

  private Fonts loadFonts(PDDocument pdf) throws IOException {
    Path body = Path.of(System.getenv().getOrDefault(
        "PDF_BODY_FONT", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"));
    Path accent = fontRoot.resolve("SokolFugner-Regular.ttf");
    Path brand = fontRoot.resolve("SokolTyrs-Regular.ttf");
    if (!Files.isRegularFile(body) || !Files.isRegularFile(accent) || !Files.isRegularFile(brand)) {
      throw new IOException("Chybí vložené fonty pro PDF export.");
    }
    PDFont bodyFont = PDType0Font.load(pdf, body.toFile());
    return new Fonts(
        bodyFont,
        bodyFont,
        PDType0Font.load(pdf, brand.toFile()),
        PDType0Font.load(pdf, accent.toFile()));
  }

  private static PDPage titlePage(
      PDDocument pdf, Fonts fonts, PdfExportSnapshot snapshot) throws IOException {
    PDPage page = new PDPage(PDRectangle.A4);
    pdf.addPage(page);
    try (PDPageContentStream stream = new PDPageContentStream(pdf, page)) {
      stream.setNonStrokingColor(RED);
      stream.addRect(0, HEIGHT - 22, WIDTH, 22);
      stream.fill();
      text(stream, fonts.brand(), 34, RED, LEFT, HEIGHT - 145, "SOKOL");
      float y = HEIGHT - 220;
      for (String line : wrap(snapshot.document().title(), fonts.heading(), 24, WIDTH - LEFT - RIGHT)) {
        text(stream, fonts.heading(), 24, DARK, LEFT, y, line);
        y -= 32;
      }
      text(stream, fonts.body(), 14, MUTED, LEFT, y - 15, "Přehled připomínek");
      text(stream, fonts.body(), 11, DARK, LEFT, y - 48,
          snapshot.document().number() + " · verze " + snapshot.document().versionNumber());
      text(stream, fonts.accent(), 10, snapshot.internal() ? RED : MUTED, LEFT, BOTTOM + 33,
          snapshot.internal() ? "INTERNÍ PRACOVNÍ EXPORT" : "VEŘEJNÝ EXPORT");
      text(stream, fonts.body(), 8.5f, MUTED, LEFT, BOTTOM + 15,
          "Vygenerováno " + snapshot.generatedAt());
    }
    return page;
  }

  private static void metadata(PDDocument pdf, PdfExportSnapshot snapshot) {
    PDDocumentInformation info = new PDDocumentInformation();
    info.setTitle("Připomínky – " + snapshot.document().title());
    info.setAuthor("Česká obec sokolská");
    info.setSubject(snapshot.internal() ? "Interní přehled připomínek" : "Veřejný přehled připomínek");
    info.setKeywords("Sokol, připomínky, participace, " + snapshot.document().number());
    pdf.setDocumentInformation(info);
  }

  private static void pdfaMetadata(PDDocument pdf, PdfExportSnapshot snapshot) throws IOException {
    ICC_Profile profile = ICC_Profile.getInstance(ColorSpace.CS_sRGB);
    PDOutputIntent intent = new PDOutputIntent(pdf, new ByteArrayInputStream(profile.getData()));
    intent.setInfo("sRGB IEC61966-2.1");
    intent.setOutputCondition("sRGB IEC61966-2.1");
    intent.setOutputConditionIdentifier("sRGB IEC61966-2.1");
    intent.setRegistryName("http://www.color.org");
    pdf.getDocumentCatalog().addOutputIntent(intent);
    String title = xml("Připomínky – " + snapshot.document().title());
    String subject = xml(snapshot.internal()
        ? "Interní přehled připomínek" : "Veřejný přehled připomínek");
    String generated = xml(snapshot.generatedAt());
    String xmp = """
        <?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
              pdfaid:part="2" pdfaid:conformance="U"/>
            <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
              xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
              <dc:format>application/pdf</dc:format>
              <dc:title><rdf:Alt><rdf:li xml:lang="x-default">%s</rdf:li></rdf:Alt></dc:title>
              <dc:creator><rdf:Seq><rdf:li>Česká obec sokolská</rdf:li></rdf:Seq></dc:creator>
              <dc:description><rdf:Alt><rdf:li xml:lang="x-default">%s</rdf:li></rdf:Alt></dc:description>
              <xmp:CreatorTool>Sokol spolu rozhoduje</xmp:CreatorTool>
              <xmp:CreateDate>%s</xmp:CreateDate><xmp:ModifyDate>%s</xmp:ModifyDate>
              <pdf:Keywords>Sokol, připomínky, participace</pdf:Keywords>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """.formatted(title, subject, generated, generated);
    PDMetadata metadata = new PDMetadata(pdf);
    metadata.importXMPMetadata(xmp.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    pdf.getDocumentCatalog().setMetadata(metadata);
  }

  private static String xml(String value) {
    if (value == null) return "";
    return value.replace("&", "&amp;").replace("<", "&lt;")
        .replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&apos;");
  }
  private static void outline(PDDocumentOutline root, String label, PDPage page) {
    PDPageFitDestination destination = new PDPageFitDestination();
    destination.setPage(page);
    PDOutlineItem item = new PDOutlineItem();
    item.setTitle(label);
    item.setDestination(destination);
    root.addLast(item);
  }

  private static void pageNumbers(
      PDDocument pdf, Fonts fonts, PdfExportSnapshot snapshot) throws IOException {
    int total = pdf.getNumberOfPages();
    for (int index = 0; index < total; index++) {
      try (PDPageContentStream stream = new PDPageContentStream(
          pdf, pdf.getPage(index), PDPageContentStream.AppendMode.APPEND, true, true)) {
        text(stream, fonts.body(), 8.5f, MUTED, LEFT, 28,
            (snapshot.internal() ? "Interní" : "Veřejný") + " export · "
                + (index + 1) + "/" + total);
      }
    }
  }

  private static void text(
      PDPageContentStream stream, PDFont font, float size, Color color,
      float x, float y, String value) throws IOException {
    stream.beginText();
    stream.setFont(font, size);
    stream.setNonStrokingColor(color);
    stream.newLineAtOffset(x, y);
    stream.showText(value == null ? "" : value);
    stream.endText();
  }

  private static List<String> wrap(String value, PDFont font, float size, float width)
      throws IOException {
    List<String> lines = new ArrayList<>();
    String normalized = value == null ? "" : value.replace('\r', ' ').trim();
    for (String paragraph : normalized.split("\\n", -1)) {
      if (paragraph.isBlank()) {
        lines.add("");
        continue;
      }
      String current = "";
      for (String word : paragraph.trim().split("\\s+")) {
        String candidate = current.isEmpty() ? word : current + " " + word;
        if (!current.isEmpty() && font.getStringWidth(candidate) * size / 1000f > width) {
          lines.add(current);
          current = word;
        } else {
          current = candidate;
        }
      }
      if (!current.isEmpty()) lines.add(current);
    }
    return lines.isEmpty() ? List.of("") : lines;
  }

  private record Fonts(PDFont body, PDFont heading, PDFont brand, PDFont accent) {}

  private static final class Flow implements AutoCloseable {
    private final PDDocument pdf;
    private final Fonts fonts;
    private final PdfExportSnapshot snapshot;
    private PDPage page;
    private PDPageContentStream stream;
    private float y;

    private Flow(PDDocument pdf, Fonts fonts, PdfExportSnapshot snapshot) {
      this.pdf = pdf;
      this.fonts = fonts;
      this.snapshot = snapshot;
    }

    private PDPage page() { return page; }

    private PDPage newPage(String section) throws IOException {
      closeStream();
      page = new PDPage(PDRectangle.A4);
      pdf.addPage(page);
      stream = new PDPageContentStream(pdf, page);
      stream.setNonStrokingColor(RED);
      stream.addRect(0, HEIGHT - 15, WIDTH, 15);
      stream.fill();
      text(stream, fonts.body(), 8.5f, MUTED, LEFT, HEIGHT - 36,
          snapshot.document().number() + " · " + section);
      y = HEIGHT - TOP;
      return page;
    }

    private void ensure(float needed) throws IOException {
      if (stream == null || y - needed < BOTTOM) newPage("Připomínky");
    }

    private void heading(String value, float size) throws IOException {
      List<String> lines = wrap(value, fonts.heading(), size, WIDTH - LEFT - RIGHT);
      ensure(lines.size() * (size + 5) + 10);
      for (String line : lines) {
        text(stream, fonts.heading(), size, DARK, LEFT, y, line);
        y -= size + 5;
      }
      y -= 7;
    }

    private void paragraph(String value, float size, Color color, float after) throws IOException {
      List<String> lines = wrap(value, fonts.body(), size, WIDTH - LEFT - RIGHT);
      ensure(lines.size() * (size + 4) + after);
      for (String line : lines) {
        text(stream, fonts.body(), size, color, LEFT, y, line);
        y -= size + 4;
      }
      y -= after;
    }

    private void statistics(PdfExportSnapshot.Statistics stats) throws IOException {
      ensure(70);
      float boxWidth = (WIDTH - LEFT - RIGHT - 20) / 3;
      int[] values = {stats.total(), stats.settled(), stats.open()};
      String[] labels = {"Celkem", "Vypořádáno", "Otevřeno"};
      for (int index = 0; index < 3; index++) {
        float x = LEFT + index * (boxWidth + 10);
        stream.setNonStrokingColor(index == 0 ? RED : LIGHT);
        stream.addRect(x, y - 50, boxWidth, 50);
        stream.fill();
        Color color = index == 0 ? Color.WHITE : DARK;
        text(stream, fonts.heading(), 20, color, x + 12, y - 21, Integer.toString(values[index]));
        text(stream, fonts.body(), 8.5f, color, x + 12, y - 39, labels[index]);
      }
      y -= 72;
    }

    private void comment(PdfExportSnapshot.Comment item) throws IOException {
      List<String> block = wrap(item.blockText(), fonts.body(), 9.2f, WIDTH - LEFT - RIGHT - 24);
      List<String> body = wrap(item.body(), fonts.body(), 10, WIDTH - LEFT - RIGHT - 24);
      List<String> statement = item.settlement() == null ? List.of()
          : wrap(item.settlement().statement(), fonts.body(), 9.3f, WIDTH - LEFT - RIGHT - 24);
      float needed = 78 + block.size() * 12 + body.size() * 14 + statement.size() * 13;
      if (snapshot.internal() && item.authorEmail() != null) needed += 13;
      if (snapshot.internal() && item.membershipId() != null) needed += 13;
      if (snapshot.internal() && item.internalNote() != null) needed += 34;
      ensure(needed);
      float top = y;
      stream.setNonStrokingColor(LIGHT);
      stream.addRect(LEFT, top - needed, WIDTH - LEFT - RIGHT, needed);
      stream.fill();
      float x = LEFT + 12;
      y -= 19;
      text(stream, fonts.heading(), 12, RED, x, y, item.publicId());
      text(stream, fonts.body(), 8.2f, MUTED, x + 150, y,
          item.type() + " · " + item.priority() + " · " + item.status());
      y -= 18;
      for (String line : block) { text(stream, fonts.body(), 9.2f, MUTED, x, y, line); y -= 12; }
      y -= 3;
      for (String line : body) { text(stream, fonts.body(), 10, DARK, x, y, line); y -= 14; }
      text(stream, fonts.body(), 8.3f, MUTED, x, y,
          item.authorName() + " · " + item.organizationName());
      y -= 13;
      if (snapshot.internal() && item.authorEmail() != null) {
        text(stream, fonts.body(), 8.3f, MUTED, x, y, "E-mail: " + item.authorEmail()); y -= 13;
      }
      if (snapshot.internal() && item.membershipId() != null) {
        text(stream, fonts.body(), 8.3f, MUTED, x, y, "Členské ID: " + item.membershipId()); y -= 13;
      }
      if (item.settlement() != null) {
        text(stream, fonts.heading(), 10.2f, DARK, x, y, "Stanovisko · " + item.settlement().outcome());
        y -= 14;
        for (String line : statement) { text(stream, fonts.body(), 9.3f, DARK, x, y, line); y -= 13; }
      }
      if (snapshot.internal() && item.internalNote() != null) {
        text(stream, fonts.heading(), 9.3f, RED, x, y, "Interní poznámka"); y -= 13;
        for (String line : wrap(item.internalNote(), fonts.body(), 9.3f, WIDTH - LEFT - RIGHT - 24)) {
          text(stream, fonts.body(), 9.3f, DARK, x, y, line); y -= 13;
        }
      }
      y = Math.min(y - 16, top - needed - 12);
    }

    private void closeStream() throws IOException {
      if (stream != null) { stream.close(); stream = null; }
    }

    @Override public void close() throws IOException { closeStream(); }
  }
}