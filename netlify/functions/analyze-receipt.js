// Netlify serverless function to analyze grocery receipt images using Claude Vision API
// Extracts food items, quantities, and prices from receipt photos

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

    // System prompt for receipt analysis
    const systemPrompt = `You are analyzing a photo of a grocery store receipt.

Your task: Extract all FOOD items from this receipt, reading the printed text carefully.

For each food item, determine:
- Product name: Clean up abbreviated receipt text into a readable name (e.g., "ORG BABY SPINACH 5OZ" becomes "Organic Baby Spinach", "GV WHL MLK GAL" becomes "Great Value Whole Milk", "BNLS SKNLS CHKN BRST" becomes "Boneless Skinless Chicken Breast")
- Quantity: Number purchased (usually 1 unless a quantity multiplier is shown, e.g., "2 @ 3.99" means quantity 2)
- Category: Produce, Proteins, Dairy, Grains, Canned Goods, Spices, Condiments, Frozen, Beverages, Snacks, Other
- Location: Infer the best storage location from the item type (Produce/Dairy/Proteins → "Fridge", Canned/Grains/Spices/Snacks → "Pantry", Frozen items → "Freezer")
- Unit price: Price per single item (number, e.g., 3.99)
- Total price: Total line price (number, e.g., 7.98 for qty 2 at 3.99 each)
- Confidence: high (clearly readable text), medium (partially readable), low (guessing)

Return ONLY valid JSON array (no markdown formatting, no code blocks, no explanation):
[
  {
    "name": "Organic Baby Spinach",
    "quantity": "1",
    "category": "Produce",
    "location": "Fridge",
    "unitPrice": 5.99,
    "totalPrice": 5.99,
    "confidence": "high"
  }
]

Rules:
- Only include FOOD and BEVERAGE items — skip tax lines, bag fees, discounts, subtotals, payment info, loyalty card numbers, coupons, and non-food items (cleaning supplies, paper goods, etc.)
- Normalize abbreviated product names into clear, readable English
- Include brand names when clearly visible (e.g., "Barilla Spaghetti" not just "Spaghetti")
- If a weight-priced item shows "1.23 lb @ 4.99/lb", set quantity to "1.23 lb" and calculate total
- If the receipt is blurry, crumpled, or partially cut off, extract what you can and mark confidence as "low" for unclear items
- If no food items are identifiable, return an empty array []
- Default quantity to "1" if not explicitly shown on the receipt`;

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
              text: 'Extract all grocery food items from this receipt image. Return only valid JSON.'
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
          message: 'No items detected on the receipt. Try a clearer, well-lit photo with the full receipt visible.'
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
        unitPrice: typeof item.unitPrice === 'number' ? item.unitPrice : null,
        totalPrice: typeof item.totalPrice === 'number' ? item.totalPrice : null,
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
          error: 'Failed to parse receipt items. Please try again.'
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
