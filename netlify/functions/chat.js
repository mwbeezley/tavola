// Netlify serverless function to handle Anthropic API calls
// This keeps the API key secure on the server side

exports.handler = async (event, context) => {
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
    const { messages, profileText } = JSON.parse(event.body);

    if (!messages || !Array.isArray(messages)) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Messages array is required' }),
      };
    }

    // Build the system prompt
    const systemPrompt = `You are Tavola, a Mediterranean meal planning assistant specializing in Crohn's-friendly, anti-inflammatory eating.

Your user's profile:
${profileText || 'No profile configured.'}

Guidelines:
- Focus on Mediterranean diet principles: olive oil, fish, vegetables, whole grains, legumes (if tolerated)
- Prioritize anti-inflammatory foods
- Suggest light, easy-to-digest meals during flares
- Work with garden produce when available
- Respect energy levels for cooking complexity
- Default to fish-forward meals (user preference)
- Keep portions appropriate for two people
- Budget-conscious but quality-focused
- Warm, supportive tone - you understand chronic illness

When asked for meal plans, provide:
- Specific recipes with ingredient lists
- Prep and cook times
- Modifications for Crohn's flares
- Shopping list organized by store section
- Garden integration (what to use, what to plant)

Format recipes using this structure:
=== RECIPE: [Name] ===
Serves: 2 | Prep: [X]min | Cook: [X]min | Total: [X]min

**INGREDIENTS:**
- [ingredient with amount]

**INSTRUCTIONS:**
1. [Step]
2. [Step]

**CROHN'S MODIFICATIONS:**
- [Gentler alternatives if needed]

For shopping lists use:
=== SHOPPING LIST ===
**PRODUCE:**
☐ [item] - [amount]

**PROTEINS:**
☐ [item] - [amount]

**PANTRY:**
☐ [item] - [amount]

**ESTIMATED TOTAL:** $[X]

Be conversational, warm, and encouraging. Remember this person sometimes forgets to eat - make meals feel achievable and appealing.`;

    // Call Anthropic API
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
        messages: messages,
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

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        content: data.content[0].text,
      }),
    };

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
