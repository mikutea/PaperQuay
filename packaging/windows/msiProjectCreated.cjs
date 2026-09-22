const fs = require('node:fs/promises');
const path = require('node:path');

const MARKER_SOURCE = path.join(__dirname, 'msi-install-marker.txt');
const COMPONENT_GROUP_CLOSE = '</ComponentGroup>';

function addMsiInstallMarker(projectXml, markerSource = MARKER_SOURCE) {
  const matches = projectXml.match(/<ComponentGroup Id="ProductComponents"[^>]*>/g) || [];
  if (matches.length !== 1 || projectXml.includes('Id="msiInstallMarker"')) {
    throw new Error('Unexpected MSI project layout; cannot add the install marker safely');
  }

  const start = projectXml.indexOf(matches[0]) + matches[0].length;
  const end = projectXml.indexOf(COMPONENT_GROUP_CLOSE, start);
  if (end < 0) {
    throw new Error('MSI project component group is incomplete');
  }

  const escapedSource = markerSource.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const marker = `\n      <Component Id="msiInstallMarkerComponent">\n        <File Id="msiInstallMarker" Name=".paperquay-msi-install" Source="${escapedSource}" KeyPath="yes"/>\n      </Component>`;
  return `${projectXml.slice(0, end)}${marker}\n    ${projectXml.slice(end)}`;
}

module.exports = async function msiProjectCreated(projectFile) {
  const xml = await fs.readFile(projectFile, 'utf8');
  await fs.writeFile(projectFile, addMsiInstallMarker(xml), 'utf8');
};
module.exports.addMsiInstallMarker = addMsiInstallMarker;
