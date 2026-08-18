param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)

function Add-ZipText([IO.Compression.ZipArchive]$Archive, [string]$Name, [string]$Content) {
  $entry = $archive.CreateEntry($Name, [IO.Compression.CompressionLevel]::Optimal)
  $entryStream = $entry.Open()
  $writer = [IO.StreamWriter]::new($entryStream, $utf8)
  $writer.Write($Content)
  $writer.Dispose()
}

function New-MinimalDocx([string]$Name, [bool]$IncludeContentTypes) {
  $target = [IO.Path]::Combine($resolvedOutput, $Name)
  $stream = [IO.File]::Open($target, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
  if ($IncludeContentTypes) {
    Add-ZipText $archive "[Content_Types].xml" '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  }
  Add-ZipText $archive "_rels/.rels" '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  Add-ZipText $archive "word/document.xml" '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Testovací dokument</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'
  Add-ZipText $archive "word/_rels/document.xml.rels" '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
  $archive.Dispose()
  $stream.Dispose()
}

New-MinimalDocx "valid-minimal.docx" $true
New-MinimalDocx "missing-content-types.docx" $false
