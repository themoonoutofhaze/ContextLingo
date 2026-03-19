const fs = require('fs');
let code = fs.readFileSync('src/ui/sidepanel.js', 'utf8');

const oldStr = `    lookupHistory.unshift({ word, context, time: new Date() });
    const wordCount = word.split(/\\s+/).filter(w => w.length > 0).length;
    if (wordCount > 1 || (context && context.length > 0)) {`;

const newStr = `    if (wordCount > 1 || (context && context.length > 0)) {`;

if (code.includes(oldStr)) {
    code = code.replace(oldStr, newStr);
    fs.writeFileSync('src/ui/sidepanel.js', code);
    console.log('patched sidepanel.js');
} else {
    console.log('Could not find string in sidepanel.js');
}
