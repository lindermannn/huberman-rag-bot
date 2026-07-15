require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('ERROR: GEMINI_API_KEY is not defined in your environment variables.');
    return;
  }
  
  console.log('Testing connection to Gemini API...');
  console.log(`Using API key: ${apiKey.substring(0, 10)}... (Length: ${apiKey.length})`);
  
  const genAI = new GoogleGenerativeAI(apiKey);
  
  // Try calling listModels or a simple generateContent with a known model
  const testModels = [
    'gemini-2.5-flash',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-pro'
  ];
  
  for (const modelName of testModels) {
    console.log(`\nTrying model: "${modelName}"...`);
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent('Say hello in Spanish');
      console.log(`Success! Response: "${result.response.text().trim()}"`);
      return; // Stop if we find a working model
    } catch (err) {
      console.error(`Failed with model "${modelName}":`, err.message);
    }
  }
  
  console.log('\nAll direct model tests failed.');
}

main();
