'use strict';
// Keep the existing portable HTML entry point synchronized with the source modules.
const filesystem = require('node:fs');
const path = require('node:path');
let markup = filesystem.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
markup = markup.replace('<link rel="stylesheet" href="./style.css" />', function () {
  return '<style>\n' + filesystem.readFileSync(path.join(__dirname, 'style.css'), 'utf8') + '\n</style>';
});
markup = markup.replace(/<script src="\.\/([^\"]+)"><\/script>/g, function (match, filename) {
  const source = filesystem.readFileSync(path.join(__dirname, filename), 'utf8');
  return '<script>\n' + source.replace(/<\/script/gi, '<\\/script') + '\n</script>';
});
filesystem.writeFileSync(path.join(__dirname, 'Volume_Pathways_3D.html'), markup);
console.log('Updated Volume_Pathways_3D.html from the application sources.');
