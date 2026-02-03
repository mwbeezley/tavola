// Netlify serverless function to analyze pantry/fridge images using Claude Vision API
// This keeps the API key secure on the server side

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

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // Get API key from environment variable
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY environment variable is not set');
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'API key not configured on server' }),
    };
  }

  try {
    // Parse the request body
    const { image, imageType } = JSON.parse(event.body);

    if (!image || !imageType) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Image and imageType are required' }),
      };
    }

    // Validate image type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(imageType)) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Invalid image type. Allowed: JPEG, PNG, GIF, WebP' }),
      };
    }

    // System prompt for pantry analysis
    const systemPrompt = `You are analyzing a photo of kitchen storage (fridge, pantry, freezer, or spice rack).

Your task: Identify all food items, ingredients, and condiments clearly visible in the image.

For each item, determine:
- Specific name (e.g., "Roma tomatoes" not just "tomatoes", "San Marzano canned tomatoes" not just "canned tomatoes")
- Approximate quantity (count if possible, or estimate: "half jar", "3-4 items", "1 lb package")
- Category: Produce, Proteins, Dairy, Grains, Canned Goods, Spices, Condiments, Frozen, Beverages, Snacks, Other
- Location: Fridge, Pantry, Freezer, Spice Rack (infer from context/temperature indicators/container types)
- Expiration concern: "Fresh" (looks good, >7 days), "Use Soon" (3-7 days or slightly wilted), "Check Date" (unclear condition or potentially expired)
- Confidence: high (clearly visible label or obvious item), medium (partially visible or common item), low (guessing based on shape/color)

Return ONLY valid JSON array (no markdown formatting, no code blocks, no explanation):
[
  {
    "name": "Roma tomatoes",
    "quantity": "4 tomatoes",
    "category": "Produce",
    "location": "Fridge",
    "expirationConcern": "Fresh",
    "confidence": "high"
  }
]

Rules:
- Only include items you can clearly identify
- Be specific with names (brand names if visible)
- Estimate quantities conservatively
- If image is blurry or dark, return fewer items with lower confidence
- If no items are identifiable, return an empty array []
- Do NOT include non-food items (containers, appliances, etc.)`;

    // Call Anthropic API with vision
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: imageType,
                data: image
              }
            },
            {
              type: 'text',
              text: 'Analyze this kitchen storage photo and identify all food items visible. Return only valid JSON.'
            }
          ]
        }]
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Anthropic API error:', response.status, errorData);
      return {
        statusCode: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          error: errorData.error?.message || `API error: ${response.status}`
        }),
      };
    }

    const data = await response.json();
    const content = data.content[0].text;

    // Extract JSON from response (handle potential markdown code blocks)
    let jsonStr = content;

    // Remove markdown code blocks if present
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // Try to find JSON array
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          items: [],
          message: 'No items detected in the image. Try a clearer photo with better lighting.'
        }),
      };
    }

    try {
      const items = JSON.parse(jsonMatch[0]);

      // Validate items structure
      const validatedItems = items.filter(item =>
        item &&
        typeof item.name === 'string' &&
        item.name.trim().length > 0
      ).map(item => ({
        name: item.name.trim(),
        quantity: item.quantity || '1',
        category: item.category || 'Other',
        location: item.location || 'Pantry',
        expirationConcern: item.expirationConcern || 'Fresh',
        confidence: item.confidence || 'medium'
      }));

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          items: validatedItems,
          count: validatedItems.length
        }),
      };
    } catch (parseError) {
      console.error('JSON parse error:', parseError, 'Content:', jsonMatch[0]);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          items: [],
          error: 'Failed to parse detected items. Please try again.'
        }),
      };
    }

  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: error.message || 'Internal server error' }),
    };
  }
};
