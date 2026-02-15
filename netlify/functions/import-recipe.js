// Netlify serverless function to import recipes from URLs
// Fetches the page, extracts recipe data via JSON-LD, microdata, or Claude fallback

const cheerio = require('cheerio');

exports.handler = async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { url } = JSON.parse(event.body);
    if (!url) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'URL is required' }),
      };
    }

    // Fetch the page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Tavola Recipe Importer/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` }),
      };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Try JSON-LD first (most reliable)
    let recipe = extractJsonLd($);

    // Try microdata if JSON-LD failed
    if (!recipe) {
      recipe = extractMicrodata($);
    }

    // Try heuristic extraction as fallback
    if (!recipe) {
      recipe = extractHeuristic($, url);
    }

    // If we still have nothing, try Claude AI as last resort
    if (!recipe && process.env.ANTHROPIC_API_KEY) {
      recipe = await extractWithClaude($, url);
    }

    if (!recipe) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Could not extract recipe data from this URL. Try a recipe page from a popular cooking site.' }),
      };
    }

    // Normalize and clean the recipe
    const normalized = normalizeRecipe(recipe, url);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(normalized),
    };
  } catch (err) {
    console.error('Import recipe error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message || 'Failed to import recipe' }),
    };
  }
};

// Extract recipe from JSON-LD structured data
function extractJsonLd($) {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      let data = JSON.parse($(scripts[i]).html());

      // Handle @graph wrapper
      if (data['@graph']) {
        data = data['@graph'];
      }

      // Handle arrays
      if (Array.isArray(data)) {
        const found = data.find(item =>
          item['@type'] === 'Recipe' ||
          (Array.isArray(item['@type']) && item['@type'].includes('Recipe'))
        );
        if (found) return parseSchemaRecipe(found);
      } else if (
        data['@type'] === 'Recipe' ||
        (Array.isArray(data['@type']) && data['@type'].includes('Recipe'))
      ) {
        return parseSchemaRecipe(data);
      }
    } catch (e) {
      // Skip invalid JSON-LD blocks
    }
  }
  return null;
}

// Parse a Schema.org Recipe object
function parseSchemaRecipe(data) {
  const recipe = {
    name: data.name || '',
    description: data.description || '',
    ingredients: [],
    instructions: [],
    prepTime: parseDuration(data.prepTime),
    cookTime: parseDuration(data.cookTime),
    totalTime: parseDuration(data.totalTime),
    servings: parseServings(data.recipeYield),
    image: parseImage(data.image),
    cuisine: Array.isArray(data.recipeCuisine) ? data.recipeCuisine.join(', ') : (data.recipeCuisine || ''),
    category: Array.isArray(data.recipeCategory) ? data.recipeCategory[0] : (data.recipeCategory || ''),
    calories: parseCalories(data.nutrition),
  };

  // Parse ingredients
  if (Array.isArray(data.recipeIngredient)) {
    recipe.ingredients = data.recipeIngredient.map(i => cleanText(i));
  }

  // Parse instructions
  if (Array.isArray(data.recipeInstructions)) {
    recipe.instructions = data.recipeInstructions.map(step => {
      if (typeof step === 'string') return cleanText(step);
      if (step['@type'] === 'HowToStep') return cleanText(step.text || step.name || '');
      if (step['@type'] === 'HowToSection' && Array.isArray(step.itemListElement)) {
        return step.itemListElement.map(s => cleanText(s.text || s.name || '')).join(' ');
      }
      return cleanText(step.text || step.name || '');
    }).filter(Boolean);
  } else if (typeof data.recipeInstructions === 'string') {
    recipe.instructions = data.recipeInstructions.split(/\n+/).map(s => cleanText(s)).filter(Boolean);
  }

  return recipe;
}

// Extract recipe from microdata attributes
function extractMicrodata($) {
  const recipeEl = $('[itemtype*="schema.org/Recipe"]');
  if (!recipeEl.length) return null;

  return {
    name: recipeEl.find('[itemprop="name"]').first().text().trim() || '',
    description: recipeEl.find('[itemprop="description"]').first().text().trim() || '',
    ingredients: recipeEl.find('[itemprop="recipeIngredient"], [itemprop="ingredients"]').map((_, el) => $(el).text().trim()).get(),
    instructions: recipeEl.find('[itemprop="recipeInstructions"] [itemprop="text"], [itemprop="step"] [itemprop="text"]').map((_, el) => $(el).text().trim()).get(),
    prepTime: parseDuration(recipeEl.find('[itemprop="prepTime"]').attr('content') || recipeEl.find('[itemprop="prepTime"]').text()),
    cookTime: parseDuration(recipeEl.find('[itemprop="cookTime"]').attr('content') || recipeEl.find('[itemprop="cookTime"]').text()),
    totalTime: parseDuration(recipeEl.find('[itemprop="totalTime"]').attr('content') || recipeEl.find('[itemprop="totalTime"]').text()),
    servings: parseServings(recipeEl.find('[itemprop="recipeYield"]').text()),
    image: recipeEl.find('[itemprop="image"]').attr('src') || recipeEl.find('[itemprop="image"]').attr('content') || '',
    cuisine: recipeEl.find('[itemprop="recipeCuisine"]').text().trim(),
    category: recipeEl.find('[itemprop="recipeCategory"]').text().trim(),
    calories: null,
  };
}

// Heuristic extraction from page content
function extractHeuristic($, url) {
  // Look for common recipe page patterns
  const title = $('h1').first().text().trim() || $('title').text().trim();
  if (!title) return null;

  // Try to find ingredient lists
  const ingredients = [];
  $('ul li').each((_, el) => {
    const text = $(el).text().trim();
    // Heuristic: ingredient lines are typically short-to-medium length
    if (text.length > 3 && text.length < 200 && looksLikeIngredient(text)) {
      ingredients.push(text);
    }
  });

  // Try to find instruction lists
  const instructions = [];
  $('ol li').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 10 && text.length < 1000) {
      instructions.push(text);
    }
  });

  if (ingredients.length < 2 && instructions.length < 2) return null;

  return {
    name: title,
    description: $('meta[name="description"]').attr('content') || '',
    ingredients,
    instructions,
    prepTime: null,
    cookTime: null,
    totalTime: null,
    servings: null,
    image: $('meta[property="og:image"]').attr('content') || '',
    cuisine: '',
    category: '',
    calories: null,
  };
}

// Use Claude to extract recipe data from page text
async function extractWithClaude($, url) {
  // Get page text, limited to avoid token overuse
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 4000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Extract recipe data from this webpage text. Return ONLY valid JSON with these fields: name, description, ingredients (array of strings), instructions (array of strings), prepTime (minutes or null), cookTime (minutes or null), servings (number or null), cuisine, category. If you cannot find a recipe, return {"error": "no recipe found"}.\n\nURL: ${url}\n\nPage text:\n${bodyText}`
        }]
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.error) return null;

    return {
      name: parsed.name || '',
      description: parsed.description || '',
      ingredients: parsed.ingredients || [],
      instructions: parsed.instructions || [],
      prepTime: parsed.prepTime,
      cookTime: parsed.cookTime,
      totalTime: parsed.prepTime && parsed.cookTime ? parsed.prepTime + parsed.cookTime : null,
      servings: parsed.servings,
      image: '',
      cuisine: parsed.cuisine || '',
      category: parsed.category || '',
      calories: null,
    };
  } catch (e) {
    console.error('Claude extraction failed:', e);
    return null;
  }
}

// Normalize and clean recipe data
function normalizeRecipe(recipe, sourceUrl) {
  return {
    name: cleanText(recipe.name) || 'Imported Recipe',
    description: cleanText(recipe.description) || '',
    ingredients: (recipe.ingredients || []).map(i => cleanText(i)).filter(Boolean),
    instructions: (recipe.instructions || []).map(i => cleanText(i)).filter(Boolean),
    prepTime: recipe.prepTime || null,
    cookTime: recipe.cookTime || null,
    totalTime: recipe.totalTime || (recipe.prepTime && recipe.cookTime ? recipe.prepTime + recipe.cookTime : null),
    servings: recipe.servings || null,
    image: recipe.image || '',
    cuisine: cleanText(recipe.cuisine) || '',
    category: cleanText(recipe.category) || '',
    calories: recipe.calories || null,
    sourceUrl: sourceUrl,
    importedAt: new Date().toISOString(),
  };
}

// Helper: Parse ISO 8601 duration to minutes
function parseDuration(duration) {
  if (!duration) return null;
  if (typeof duration === 'number') return duration;
  const str = String(duration);
  const match = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (match) {
    return (parseInt(match[1] || 0) * 60) + parseInt(match[2] || 0) + Math.ceil(parseInt(match[3] || 0) / 60);
  }
  // Try plain number
  const num = parseInt(str);
  return isNaN(num) ? null : num;
}

// Helper: Parse servings
function parseServings(yield_val) {
  if (!yield_val) return null;
  if (typeof yield_val === 'number') return yield_val;
  const str = Array.isArray(yield_val) ? yield_val[0] : String(yield_val);
  const match = str.match(/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

// Helper: Parse image from various formats
function parseImage(image) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return image[0] || '';
  if (image.url) return image.url;
  if (image['@id']) return image['@id'];
  return '';
}

// Helper: Parse calories from nutrition object
function parseCalories(nutrition) {
  if (!nutrition) return null;
  const cal = nutrition.calories || nutrition.Calories || '';
  const match = String(cal).match(/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

// Helper: Clean text
function cleanText(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').replace(/<[^>]*>/g, '').trim();
}

// Helper: Check if text looks like an ingredient
function looksLikeIngredient(text) {
  const lower = text.toLowerCase();
  // Contains measurement words or common ingredient patterns
  const measurements = /\b(cup|cups|tbsp|tsp|tablespoon|teaspoon|oz|ounce|pound|lb|gram|kg|ml|liter|pinch|dash|clove|bunch|can|package|pkg|bag|slice|piece|whole|half|quarter|large|medium|small|fresh|dried|minced|chopped|diced)\b/;
  const ingredients = /\b(salt|pepper|oil|butter|garlic|onion|sugar|flour|egg|milk|cream|cheese|chicken|beef|pork|fish|rice|pasta|tomato|lemon|herb|spice|sauce|vinegar|broth|stock|water)\b/;
  return measurements.test(lower) || ingredients.test(lower);
}
