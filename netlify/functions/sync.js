// Netlify serverless function to handle cloud sync
// Uses a simple hash-based approach without requiring authentication

// In-memory storage for demo (in production, use a database like Netlify Blobs or a KV store)
// For now, we'll use Netlify Blobs via the Blobs API

exports.handler = async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      },
      body: '',
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, syncCode, data } = body;

    if (!syncCode || syncCode.length < 3) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid sync code. Must be at least 3 characters.' }),
      };
    }

    // Create a simple hash from the sync code for the storage key
    const storageKey = `tavola_sync_${syncCode.toLowerCase().replace(/[^a-z0-9-]/g, '_')}`;

    // Use Netlify Blobs for storage (available in Netlify Functions)
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('tavola-sync');

    if (action === 'upload') {
      if (!data) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'No data provided for upload' }),
        };
      }

      // Store the data with timestamp
      const payload = {
        data,
        uploadedAt: new Date().toISOString(),
        version: '3.0'
      };

      await store.setJSON(storageKey, payload);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'Data uploaded successfully',
          uploadedAt: payload.uploadedAt
        }),
      };

    } else if (action === 'download') {
      const payload = await store.get(storageKey, { type: 'json' });

      if (!payload) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({
            error: 'No data found for this sync code. Upload data first or check the code.'
          }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          data: payload.data,
          uploadedAt: payload.uploadedAt,
          version: payload.version
        }),
      };

    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid action. Use "upload" or "download".' }),
      };
    }

  } catch (error) {
    console.error('Sync function error:', error);

    // If Netlify Blobs isn't available, fall back to a simple response
    if (error.message?.includes('@netlify/blobs')) {
      return {
        statusCode: 501,
        headers,
        body: JSON.stringify({
          error: 'Cloud sync requires Netlify Blobs. Please use local export/import for now.',
          fallback: true
        }),
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Internal server error' }),
    };
  }
};
