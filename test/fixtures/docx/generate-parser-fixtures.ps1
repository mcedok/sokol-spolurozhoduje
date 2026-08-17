param([Parameter(Mandatory = $true)][string]$OutputDirectory)

$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)

function Add-ZipText([IO.Compression.ZipArchive]$Archive, [string]$Name, [string]$Content) {
  $entry = $Archive.CreateEntry($Name, [IO.Compression.CompressionLevel]::Optimal)
  $writer = [IO.StreamWriter]::new($entry.Open(), $utf8)
  $writer.Write($Content)
  $writer.Dispose()
}

function New-TestDocx(
  [string]$Name,
  [string]$DocumentXml,
  [string]$RelationshipsXml,
  [string]$StylesXml = '',
  [string]$NumberingXml = ''
) {
  $stream = [IO.File]::Open(
    [IO.Path]::Combine($resolvedOutput, $Name),
    [IO.FileMode]::Create,
    [IO.FileAccess]::ReadWrite
  )
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
  Add-ZipText $archive '[Content_Types].xml' '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>'
  Add-ZipText $archive '_rels/.rels' '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  Add-ZipText $archive 'word/document.xml' $DocumentXml
  Add-ZipText $archive 'word/_rels/document.xml.rels' $RelationshipsXml
  if ($StylesXml) { Add-ZipText $archive 'word/styles.xml' $StylesXml }
  if ($NumberingXml) { Add-ZipText $archive 'word/numbering.xml' $NumberingXml }
  $archive.Dispose()
  $stream.Dispose()
}

$emptyRels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
$styles = '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style><w:style w:type="paragraph" w:styleId="Callout"><w:name w:val="Callout"/></w:style></w:styles>'
$numbering = '<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="11"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="11"/></w:num></w:numbering>'
$supportedRels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdWeb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.sokol.eu" TargetMode="External"/></Relationships>'
$supported = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p w14:paraId="A1B2C3D4"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Směrnice</w:t></w:r></w:p><w:p><w:bookmarkStart w:id="1" w:name="uvod"/><w:r><w:t xml:space="preserve">Běžný </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>tučný</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> kurzíva</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve"> podtržený</w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve"> zvýrazněný</w:t></w:r><w:hyperlink r:id="rIdWeb"><w:r><w:t xml:space="preserve"> web</w:t></w:r></w:hyperlink><w:bookmarkEnd w:id="1"/></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>První bod</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Odrážka</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>Citace</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Podnadpis podle stylu</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Callout"/></w:pPr><w:r><w:t>Důležité upozornění</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p></w:body></w:document>'
New-TestDocx 'supported-elements.docx' $supported $supportedRels $styles $numbering

$bookmarks = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p><w:bookmarkStart w:id="1" w:name="clanek-1"/><w:r><w:t>Stejný text</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p><w:p w14:paraId="1122AABB"><w:r><w:t>Stejný text</w:t></w:r></w:p></w:body></w:document>'
New-TestDocx 'bookmarks-and-ids.docx' $bookmarks $emptyRels

$unsafeRels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdUnsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="rIdMail" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:info@sokol.eu" TargetMode="External"/></Relationships>'
$unsafe = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="rIdUnsafe"><w:r><w:t>Nebezpečný</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> a </w:t></w:r><w:hyperlink r:id="rIdMail"><w:r><w:t>e-mail</w:t></w:r></w:hyperlink></w:p></w:body></w:document>'
New-TestDocx 'unsafe-links.docx' $unsafe $unsafeRels
