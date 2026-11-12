"""Build the file that installs the extension in VS Code (a .vsix file).

Run this script from any folder:

    python3 scripts/package.py

The script writes dbx-notebook-<version>.vsix into the project folder. It
reads the name and the version from package.json. You do not need Node.js.

A .vsix file is a zip file that contains:

- extension/           the files in FILES below
- extension.vsixmanifest   the name, the version and the description, as XML
- [Content_Types].xml      the file types in the zip file

Install the extension with one of these:

    code --install-extension dbx-notebook-0.0.1.vsix
    VS Code command palette > "Extensions: Install from VSIX..."

If you add a source file outside src/, add it to FILES. If you do not, the
installed extension will not contain the file.
"""
import json
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent

# The files that the installed extension contains. The test scripts and the samples are not in the list.
# README.md has links to the two other .md files, thus the list contains them.
FILES = ["package.json", "extension.js", "README.md", "docs/how-it-works.md", "test/README.md", *sorted(str(p.relative_to(ROOT)) for p in (ROOT / "src").glob("*.js"))]

pkg = json.loads((ROOT / "package.json").read_text())
ident = f'{pkg["publisher"]}.{pkg["name"]}'

manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(pkg["name"])}" Version="{escape(pkg["version"])}" Publisher="{escape(pkg["publisher"])}"/>
    <DisplayName>{escape(pkg["displayName"])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg["description"])}</Description>
    <Categories>{escape(",".join(pkg.get("categories", [])))}</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg["engines"]["vscode"])}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
  </Assets>
</PackageManifest>
"""

content_types = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
"""

out = ROOT / f'{pkg["name"]}-{pkg["version"]}.vsix'
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("extension.vsixmanifest", manifest)
    for f in FILES:
        z.write(ROOT / f, f"extension/{f}")
print(f"{out.name}  ({ident}, {len(FILES)} files, {out.stat().st_size} bytes)")
