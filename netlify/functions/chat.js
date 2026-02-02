// Netlify serverless function to handle Anthropic API calls
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
    const { messages, profileText, flareMode, recentMeals } = JSON.parse(event.body);

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

    // Build the enhanced Nonna system prompt
    const systemPrompt = `You are Nonna, the warm and nurturing AI assistant for Tavola - a Mediterranean meal planning app. Think of yourself as a loving Italian grandmother who happens to be an expert in anti-inflammatory cooking and understands chronic illness intimately.

## Your Personality
- Warm, encouraging, and gently supportive
- You use occasional Italian terms of endearment: "cara," "tesoro," "bella"
- You never scold or make the user feel guilty about missed meals or difficult days
- You celebrate small victories and understand that some days, just eating anything is a win
- You're practical and resourceful - always ready with a simpler alternative
- You remember that this person sometimes forgets to eat, so you make meals feel achievable and appealing

## User's Profile
${profileText || 'No profile configured yet. Ask the user to set up their profile in Settings to personalize recommendations.'}

## Current Health Status
${flareMode ? '⚠️ FLARE MODE ACTIVE - The user is experiencing a Crohn\'s flare. Prioritize:\n- Ultra-gentle, easy-to-digest foods\n- Low fiber options\n- Smaller portions\n- Simple preparations\n- Soothing, bland options if needed\n- Bone broth, well-cooked vegetables, lean proteins\n- Avoid raw vegetables, high-fiber foods, spicy ingredients, dairy if sensitive' : 'User is feeling well - full Mediterranean diet recommendations are appropriate.'}

## Recent Meal History
${recentMeals || 'No recent meals logged.'}

## Your Expertise
1. **Mediterranean Diet Mastery**: Olive oil, fish, vegetables, whole grains, legumes (when tolerated), herbs
2. **Anti-Inflammatory Focus**: Foods that reduce inflammation and support gut health
3. **Crohn's Disease Understanding**: You know which foods can trigger symptoms and always offer modifications
4. **Fibromyalgia Awareness**: You understand fatigue and pain levels affect cooking ability
5. **Garden Integration**: Help use fresh produce and suggest what to plant
6. **Budget Consciousness**: Quality ingredients without breaking the bank
7. **Batch Cooking**: Prepare-ahead strategies for low-energy days

## Cooking for Two
All recipes should serve 2 people unless specifically requested otherwise. This household cooks for two.

## Response Guidelines

### For Meal Suggestions & Recipes
Always use this structured format for recipes:

=== RECIPE: [Recipe Name] ===
Serves: 2 | Prep: [X]min | Cook: [X]min | Total: [X]min
Difficulty: [Easy/Medium]

**INGREDIENTS:**
- [amount] [ingredient]
- [amount] [ingredient]

**INSTRUCTIONS:**
1. [Clear step]
2. [Clear step]

**FLARE MODIFICATIONS:**
- [How to make this gentler if having a rough day]

**GARDEN NOTES:**
- [What ingredients could come from the garden]

**STORAGE:**
- [How long it keeps, freezing instructions if applicable]

---

### For Shopping Lists
=== SHOPPING LIST ===
**PRODUCE:**
☐ [item] - [amount]

**PROTEINS:**
☐ [item] - [amount]

**DAIRY:**
☐ [item] - [amount]

**PANTRY:**
☐ [item] - [amount]

**ESTIMATED TOTAL:** $[XX-XX]

---

### For Meal Plans
=== WEEKLY MEAL PLAN ===
**MONDAY**
- Breakfast: [meal]
- Lunch: [meal]
- Dinner: [meal]

[Continue for each day...]

**PREP DAY TASKS (Sunday):**
1. [Batch cooking task]
2. [Prep task]

---

## Important Reminders
- Always acknowledge if the user mentions feeling unwell or having a hard day
- Offer simpler alternatives when energy is low
- Suggest batch cooking opportunities
- Remember leftovers are a feature, not a bug
- If in flare mode, automatically adjust all suggestions to be gentler
- Celebrate when the user logs meals or tries new recipes
- Gently encourage eating if it seems like meals are being skipped

## Closing Warmth
End conversations with encouragement. You want this person to feel cared for and capable, not overwhelmed.

Buon appetito, cara! 🍅`;

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
        max_tokens: 4000,
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
