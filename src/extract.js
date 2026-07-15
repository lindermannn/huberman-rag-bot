const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoPath = path.resolve(__dirname, '..', 'Huberman-Lab-Wiki');
const outputPath = path.resolve(__dirname, '..', 'data', 'raw');

// Ensure output directories exist
if (!fs.existsSync(outputPath)) {
  fs.mkdirSync(outputPath, { recursive: true });
}

function runGitCommand(args) {
  try {
    return execSync(`git ${args}`, { cwd: repoPath, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (error) {
    console.error(`Error executing git ${args}:`, error.message);
    throw error;
  }
}

function main() {
  console.log('Listing files in git repository...');
  const lsTreeOutput = runGitCommand('ls-tree -r HEAD --name-only');
  const files = lsTreeOutput.trim().split('\n');

  console.log(`Found ${files.length} total files. Filtering episode content...`);

  const episodes = {};

  for (const filePath of files) {
    if (!filePath.startsWith('docs/Episodes/')) continue;
    if (filePath.endsWith('index.md')) continue;

    // Path structure: docs/Episodes/EP-XXX - Title/summary.md or transcript.md
    const parts = filePath.split('/');
    if (parts.length < 4) continue;

    const folderName = parts[2]; // e.g. "EP-065 - Dr. Andy Galpin: How to Build Strength..."
    const fileName = parts[3];   // e.g. "summary.md" or "transcript.md"

    if (fileName !== 'summary.md' && fileName !== 'transcript.md') continue;

    let episodeId = "";
    let title = "";
    const dashIndex = folderName.indexOf(' - ');

    if (dashIndex !== -1) {
      episodeId = folderName.substring(0, dashIndex).trim();
      title = folderName.substring(dashIndex + 3).trim();
    } else {
      episodeId = folderName;
      title = folderName;
    }

    if (!episodes[episodeId]) {
      episodes[episodeId] = {
        id: episodeId,
        title: title,
        originalFolder: folderName,
        files: {}
      };
    }

    episodes[episodeId].files[fileName] = filePath;
  }

  const episodeIds = Object.keys(episodes);
  console.log(`Identified ${episodeIds.length} episodes to extract.`);

  let extractedCount = 0;
  const metadata = {};

  for (const episodeId of episodeIds) {
    const ep = episodes[episodeId];
    const epDir = path.join(outputPath, episodeId);

    if (!fs.existsSync(epDir)) {
      fs.mkdirSync(epDir, { recursive: true });
    }

    const info = {
      id: episodeId,
      title: ep.title,
      originalFolder: ep.originalFolder,
      hasSummary: false,
      hasTranscript: false
    };

    // Extract summary
    if (ep.files['summary.md']) {
      try {
        const rawContent = runGitCommand(`show "HEAD:${ep.files['summary.md']}"`);
        fs.writeFileSync(path.join(epDir, 'summary.md'), rawContent, 'utf8');
        info.hasSummary = true;
      } catch (err) {
        console.error(`Failed to extract summary for ${episodeId}:`, err.message);
      }
    }

    // Extract transcript
    if (ep.files['transcript.md']) {
      try {
        const rawContent = runGitCommand(`show "HEAD:${ep.files['transcript.md']}"`);
        fs.writeFileSync(path.join(epDir, 'transcript.md'), rawContent, 'utf8');
        info.hasTranscript = true;
      } catch (err) {
        console.error(`Failed to extract transcript for ${episodeId}:`, err.message);
      }
    }

    metadata[episodeId] = info;
    extractedCount++;

    if (extractedCount % 50 === 0 || extractedCount === episodeIds.length) {
      console.log(`Extracted ${extractedCount}/${episodeIds.length} episodes...`);
    }
  }

  // Save metadata index
  fs.writeFileSync(path.join(outputPath, 'index.json'), JSON.stringify(metadata, null, 2), 'utf8');
  console.log('Extraction complete! Raw metadata saved to data/raw/index.json');
}

if (require.main === module) {
  main();
}

module.exports = { main };
