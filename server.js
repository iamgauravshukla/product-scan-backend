require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;
const sharp = require('sharp');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('../'));

// Add compression for faster response times
const compression = require('compression');
app.use(compression());

// WooCommerce API Configuration
const WooCommerce = new WooCommerceRestApi({
    url: process.env.WOOCOMMERCE_URL,
    consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
    consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
    version: 'wc/v3'
});

// OpenAI Configuration
const openai = process.env.API_KEY ? new OpenAI({
    apiKey: process.env.API_KEY
}) : null;

// Logger - always output logs
const log = console.log;

// Performance caches
const productCache = new Map(); // Cache WooCommerce products
const categoryCache = new Map(); // Cache categories
const scoreCache = new Map(); // Cache score calculations
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const PRODUCT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes for products

// Normalize and preprocess ingredients
function normalizeIngredient(ingredient) {
    return ingredient
        .toLowerCase()
        .trim()
        .replace(/[()\[\]]/g, '') // Remove parentheses and brackets
        .replace(/\s+/g, ' '); // Normalize spaces
}

// Create a Set of normalized ingredients for fast lookup
function preprocessIngredients(ingredientsText) {
    if (!ingredientsText) return new Set();
    
    const ingredients = typeof ingredientsText === 'string'
        ? ingredientsText.split(/[,;\n]/).map(i => normalizeIngredient(i))
        : ingredientsText.map(i => normalizeIngredient(i));
    
    return new Set(ingredients.filter(i => i.length > 0));
}

// Better ingredient matching with word boundaries and exact matches
function hasIngredient(ingredientSet, searchIngredient) {
    const normalized = normalizeIngredient(searchIngredient);
    
    // Direct match
    if (ingredientSet.has(normalized)) return true;
    
    // Check for matches with word boundaries
    for (const ingredient of ingredientSet) {
        // Exact match
        if (ingredient === normalized) return true;
        
        // Match as complete word (with boundaries)
        const regex = new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (regex.test(ingredient)) return true;
    }
    
    return false;
}

// Generate cache key for scoring (per product + conditions)
// Note: Description is NOT included because it doesn't affect scoring algorithm
// Only used for lifestyle suggestions. Image is also not included since
// AI-detected conditions are merged into the conditions array.
function generateScoreCacheKey(productId, conditions) {
    return `${productId}_${conditions.sort().join('_')}`;
}

// Generate cache key for products (budget-based, NOT condition-based)
function generateProductCacheKey(budget) {
    return `products_budget_${budget}`;
}

// Clean expired cache entries periodically
function cleanExpiredCache() {
    const now = Date.now();
    let cleaned = 0;
    
    // Clean score cache
    for (const [key, value] of scoreCache.entries()) {
        if (now - value.timestamp >= CACHE_TTL) {
            scoreCache.delete(key);
            cleaned++;
        }
    }
    
    // Clean product cache
    for (const [key, value] of productCache.entries()) {
        if (now - value.timestamp >= PRODUCT_CACHE_TTL) {
            productCache.delete(key);
            cleaned++;
        }
    }
    
    // Clean category cache
    for (const [key, value] of categoryCache.entries()) {
        if (now - value.timestamp >= PRODUCT_CACHE_TTL) {
            categoryCache.delete(key);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} expired cache entries`);
    }
}

// Clean cache every 10 minutes
setInterval(cleanExpiredCache, 10 * 60 * 1000);

// Ingredient Database - Maps skin conditions to beneficial/harmful ingredients
const INGREDIENT_DATABASE = {
    acne: {
        beneficial: [
            'salicylic acid', 'capryloyl salicylic acid', 'benzoyl peroxide', 
            'niacinamide', 'tea tree', 'zinc', 'sulfur', 'glycolic acid',
            'sodium hyaluronate', 'adenosine', 'tocopherol', 'ascorbyl glucoside',
            'sodium lactate', 'hydroxyacetophenone', 'caprylic/capric triglyceride'
        ],
        avoid: [
            'coconut oil', 'cocoa butter', 'palm oil', 'isopropyl myristate',
            'stearyl alcohol', 'ceteareth-6', 'parfum/fragrance', 'alcohol denat.',
            'methylparaben', 'synthetic wax', 'dimethicone'
        ]
    },
    oily: {
        beneficial: [
            'niacinamide', 'salicylic acid', 'capryloyl salicylic acid', 
            'clay', 'charcoal', 'witch hazel', 'zinc', 'silica',
            'glycolic acid', 'alcohol denat.', 'hydroxyacetophenone'
        ],
        avoid: [
            'mineral oil', 'petrolatum', 'silicones', 'heavy oils',
            'dimethicone', 'isohexadecane', 'caprylic/capric triglyceride',
            'stearyl alcohol', 'ceteareth-6', 'synthetic wax'
        ]
    },
    dry: {
        beneficial: [
            'hyaluronic acid', 'sodium hyaluronate', 'glycerin', 'ceramides', 
            'squalane', 'shea butter', 'jojoba oil', 'caprylic/capric triglyceride',
            'dimethicone', 'tocopherol', 'tocopheryl acetate', 'butylene glycol',
            'pentylene glycol', 'propanediol', 'dipropylene glycol', 'glyceryl stearate',
            'stearyl alcohol', 'ceteareth-6'
        ],
        avoid: [
            'alcohol denat.', 'fragrance', 'parfum/fragrance', 'sulfates', 
            'high ph cleansers', 'sodium lauryl sulfate', 'methylparaben',
            'phenoxyethanol'
        ]
    },
    sensitive: {
        beneficial: [
            'centella asiatica', 'aloe vera', 'oat', 'chamomile', 'allantoin', 
            'bisabolol', 'niacinamide', 'sodium hyaluronate', 'glycerin',
            'dipotassium glycyrrhizate', 'tocopherol', 'adenosine',
            'caprylic/capric triglyceride', 'propanediol'
        ],
        avoid: [
            'fragrance', 'parfum/fragrance', 'essential oils', 'alcohol', 
            'alcohol denat.', 'retinol', 'retinyl palmitate', 'high concentrations of acids',
            'linalool', 'citronellol', 'limonene', 'benzyl alcohol', 'benzyl salicylate',
            'geraniol', 'hexyl cinnamal', 'methylparaben', 'phenoxyethanol'
        ]
    },
    redness: {
        beneficial: [
            'centella asiatica', 'niacinamide', 'azelaic acid', 'green tea', 
            'licorice root', 'dipotassium glycyrrhizate', 'sodium hyaluronate',
            'tocopherol', 'adenosine', 'glycerin', 'paeonia suffruticosa root extract',
            'caprylic/capric triglyceride'
        ],
        avoid: [
            'fragrance', 'parfum/fragrance', 'menthol', 'eucalyptus', 
            'high concentrations of vitamin c', 'alcohol denat.',
            'linalool', 'citronellol', 'limonene', 'benzyl alcohol'
        ]
    },
    'dark-spots': {
        beneficial: [
            'vitamin c', 'ascorbyl glucoside', 'niacinamide', 'kojic acid', 
            'alpha arbutin', 'licorice root', 'dipotassium glycyrrhizate',
            'azelaic acid', 'glycolic acid', 'retinol', 'retinyl palmitate',
            'tocopherol', 'adenosine', 'paeonia suffruticosa root extract',
            'pancratium maritimum extract'
        ],
        avoid: [
            'harsh scrubs', 'fragrance', 'parfum/fragrance', 'alcohol denat.',
            'methylparaben'
        ]
    },
    wrinkles: {
        beneficial: [
            'retinol', 'retinyl palmitate', 'peptides', 'palmitoyl tripeptide-1',
            'palmitoyl tetrapeptide-7', 'vitamin c', 'ascorbyl glucoside',
            'hyaluronic acid', 'sodium hyaluronate', 'niacinamide', 
            'coenzyme q10', 'glycerin', 'adenosine', 'tocopherol',
            'tocopheryl acetate', 'glycolic acid', 'dimethicone',
            'caprylic/capric triglyceride'
        ],
        avoid: [
            'fragrance', 'parfum/fragrance', 'alcohol denat.', 'harsh scrubs',
            'methylparaben'
        ]
    },
    'large-pores': {
        beneficial: [
            'niacinamide', 'salicylic acid', 'capryloyl salicylic acid',
            'retinol', 'retinyl palmitate', 'clay masks', 'azelaic acid',
            'glycolic acid', 'silica', 'adenosine'
        ],
        avoid: [
            'heavy oils', 'silicones', 'dimethicone', 'isohexadecane',
            'stearyl alcohol', 'synthetic wax'
        ]
    },
    'uneven-texture': {
        beneficial: [
            'glycolic acid', 'lactic acid', 'retinol', 'retinyl palmitate',
            'enzyme exfoliants', 'niacinamide', 'salicylic acid',
            'capryloyl salicylic acid', 'ascorbyl glucoside', 'adenosine',
            'sodium hyaluronate'
        ],
        avoid: [
            'harsh scrubs', 'fragrance', 'parfum/fragrance', 'alcohol denat.',
            'methylparaben'
        ]
    }
};

// Budget ranges for filtering
const BUDGET_RANGES = {
    low: { min: 0, max: 1000 },
    mid: { min: 0, max: 2500 },
    high: { min: 2500, max: 5000 },
    luxury: { min: 5000, max: 999999 }
};

// Valid skin conditions
const VALID_CONDITIONS = [
    'acne', 'dark-spots', 'wrinkles', 'redness', 'large-pores',
    'uneven-texture', 'dry', 'oily', 'sensitive'
];

// Input Validation Helper Functions
function validateConditions(conditions) {
    if (!Array.isArray(conditions)) {
        return { valid: false, error: 'Conditions must be an array' };
    }
    if (conditions.length === 0) {
        return { valid: false, error: 'Please select at least one skin condition' };
    }
    if (conditions.length > 5) {
        return { valid: false, error: 'Maximum 5 conditions allowed' };
    }
    
    // Check if all conditions are valid
    const invalid = conditions.filter(c => !VALID_CONDITIONS.includes(c));
    if (invalid.length > 0) {
        return { valid: false, error: `Invalid condition(s): ${invalid.join(', ')}. Valid options: ${VALID_CONDITIONS.join(', ')}` };
    }
    
    return { valid: true };
}

function validateBudget(budget) {
    if (!budget) {
        return { valid: true }; // Budget is optional
    }
    if (typeof budget !== 'string') {
        return { valid: false, error: 'Budget must be a string' };
    }
    if (!BUDGET_RANGES[budget.toLowerCase()]) {
        return { valid: false, error: `Invalid budget. Valid options: ${Object.keys(BUDGET_RANGES).join(', ')}` };
    }
    return { valid: true };
}

function validateDescription(description) {
    if (!description) {
        return { valid: true }; // Description is optional
    }
    if (typeof description !== 'string') {
        return { valid: false, error: 'Description must be a string' };
    }
    if (description.length > 500) {
        return { valid: false, error: 'Description must be 500 characters or less' };
    }
    if (description.length < 3) {
        return { valid: false, error: 'Description must be at least 3 characters' };
    }
    return { valid: true };
}

function validateImage(image) {
    if (!image) {
        return { valid: false, error: 'Image is required. Please upload a face selfie' };
    }
    if (typeof image !== 'string') {
        return { valid: false, error: 'Image must be a base64 string' };
    }
    
    // Check image size (rough estimate: base64 is ~4/3 of binary size)
    const estimatedSizeInBytes = (image.length * 3) / 4;
    const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
    
    if (estimatedSizeInBytes > MAX_IMAGE_SIZE) {
        return { valid: false, error: 'Image is too large. Maximum size: 10MB' };
    }
    
    // Check if it's a valid base64 data URI
    if (!image.includes('base64') && !image.match(/^[A-Za-z0-9+/=]+$/)) {
        return { valid: false, error: 'Invalid image format. Must be base64 encoded' };
    }
    
    return { valid: true };
}

// Optimize Image
async function optimizeImage(base64Image) {
    try {
        // Remove data:image/...;base64, prefix
        const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        // Optimize using sharp
        const optimizedBuffer = await sharp(buffer)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

        return optimizedBuffer.toString('base64');
    } catch (error) {
        console.error('Image optimization error:', error);
        throw error;
    }
}

// Validate that the image is a human face selfie
async function validateFaceSelfie(base64Image) {
    if (!openai) {
        console.warn('OpenAI not configured, skipping face validation');
        return { isValid: true, message: 'Validation skipped' };
    }

    try {
        // Remove data:image/...;base64, prefix if present
        const imageData = base64Image.includes(',') 
            ? base64Image.split(',')[1] 
            : base64Image;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "You are an image validator. Check if the uploaded image is a clear photo of a human face (selfie, front-facing face photo). Respond with ONLY a JSON object in this format: {\"isHumanFace\": true/false, \"reason\": \"explanation\"}"
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Is this a clear photo of a human face? Respond with ONLY a JSON object: {\"isHumanFace\": true/false, \"reason\": \"brief reason\"}"
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${imageData}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 100,
            temperature: 0.1
        });

        const validationResponse = response.choices[0].message.content;
        console.log(`\n✅ Face validation response: ${validationResponse}`);

        try {
            const parsed = JSON.parse(validationResponse);
            return {
                isValid: parsed.isHumanFace === true,
                message: parsed.reason || 'Image validation completed'
            };
        } catch (e) {
            // If response isn't valid JSON, try to infer from text
            const text = validationResponse.toLowerCase();
            const isValid = !text.includes('not') && !text.includes('invalid') && text.includes('face');
            return {
                isValid,
                message: validationResponse
            };
        }
    } catch (error) {
        console.error('Face validation error:', error?.message);
        // If validation fails, allow the image (fail open for safety)
        return { isValid: true, message: 'Validation service unavailable' };
    }
}

// Analyze skin image using OpenAI Vision API
async function analyzeSkinImage(base64Image) {
    if (!openai) {
        console.warn('OpenAI API key not configured, skipping image analysis');
        return {
            detectedConditions: [],
            skinType: 'combination',
            confidence: 0.85,
            note: 'AI analysis not available'
        };
    }

    try {
        // Remove data:image/...;base64, prefix if present
        const imageData = base64Image.includes(',') 
            ? base64Image.split(',')[1] 
            : base64Image;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            response_format: { type: "json_object" }, // Force JSON response
            messages: [
                {
                    role: "system",
                    content: `You are a dermatology AI assistant. Analyze skin images and identify:
1. Visible skin conditions (acne, dark spots, wrinkles, redness, large pores, uneven texture, dryness, oiliness, sensitivity)
2. Skin type (oily, dry, combination, sensitive, normal)
3. Overall skin health assessment
4. Specific concerns visible in the image

IMPORTANT: You MUST respond with ONLY a valid JSON object, no markdown formatting, no code blocks, no extra text. The response must be parseable JSON.

Return a JSON object with this exact structure:
{
  "detectedConditions": ["acne", "oily"],
  "skinType": "combination",
  "confidence": 0.85,
  "observations": ["Visible acne lesions", "Oily T-zone"],
  "recommendations": ["Use salicylic acid cleanser", "Apply niacinamide serum"]
}`
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Analyze this skin image and provide a detailed assessment. Focus on identifying skin conditions, skin type, and any visible concerns. Respond with ONLY a valid JSON object in this format: {\"detectedConditions\": [], \"skinType\": \"\", \"confidence\": 0.0, \"observations\": [], \"recommendations\": []}. Do not use markdown code blocks or any formatting."
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${imageData}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 500,
            temperature: 0.3
        });

        const analysisText = response.choices[0].message.content;
        
        // Debug: Log OpenAI raw response when DEBUG=true
        console.log('\n🤖 OpenAI API Response:');
        console.log('   Model:', response.model);
        console.log('   Usage:', {
            prompt_tokens: response.usage?.prompt_tokens,
            completion_tokens: response.usage?.completion_tokens,
            total_tokens: response.usage?.total_tokens
        });
        console.log('   Raw Response Text:');
        console.log('   ' + '─'.repeat(60));
        console.log(analysisText);
        console.log('   ' + '─'.repeat(60));
        
        // Try to parse JSON from response with multiple strategies
        let analysis;
        try {
            // Strategy 1: Extract JSON from markdown code blocks (```json ... ```)
            let jsonMatch = analysisText.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
                analysis = JSON.parse(jsonMatch[1].trim());
            } else {
                // Strategy 2: Extract JSON from regular code blocks (``` ... ```)
                jsonMatch = analysisText.match(/```\s*([\s\S]*?)\s*```/);
                if (jsonMatch) {
                    try {
                        analysis = JSON.parse(jsonMatch[1].trim());
                    } catch (e) {
                        // Not JSON in code block, continue
                    }
                }
            }
            
            // Strategy 3: Find JSON object in text (look for { ... })
            if (!analysis) {
                const jsonObjectMatch = analysisText.match(/\{[\s\S]*\}/);
                if (jsonObjectMatch) {
                    analysis = JSON.parse(jsonObjectMatch[0]);
                }
            }
            
            // Strategy 4: Try parsing the entire text directly
            if (!analysis) {
                analysis = JSON.parse(analysisText.trim());
            }
            
            // Validate that we got the expected structure
            if (analysis && typeof analysis === 'object') {
                console.log('\n✅ Successfully parsed OpenAI JSON response:');
                log(JSON.stringify(analysis, null, 2));
            }
            
        } catch (parseError) {
            // If all JSON parsing strategies fail, extract information from text
            console.warn('\n⚠️ Failed to parse OpenAI response as JSON, extracting from text');
            console.warn('Parse error:', parseError.message);
            console.log('Response preview (first 300 chars):', analysisText.substring(0, 300));
            console.log('Full response length:', analysisText.length);
            
            // Try to extract structured data from text using regex
            analysis = extractStructuredDataFromText(analysisText);
            console.log('\n📝 Extracted analysis from text:');
            log(JSON.stringify({
                conditions: analysis.detectedConditions,
                skinType: analysis.skinType,
                confidence: analysis.confidence,
                observations: analysis.observations?.slice(0, 3),
                recommendations: analysis.recommendations?.slice(0, 3)
            }, null, 2));
        }

        const finalAnalysis = {
            detectedConditions: analysis.detectedConditions || [],
            skinType: analysis.skinType || 'combination',
            confidence: analysis.confidence || 0.8,
            observations: analysis.observations || [],
            recommendations: analysis.recommendations || []
        };
        
        // Debug-only summary of AI analysis
        console.log('\n📋 Final AI Analysis Summary:');
        log(`   Detected Conditions: ${finalAnalysis.detectedConditions.length > 0 ? finalAnalysis.detectedConditions.join(', ') : 'None'}`);
        log(`   Skin Type: ${finalAnalysis.skinType}`);
        log(`   Confidence: ${(finalAnalysis.confidence * 100).toFixed(1)}%`);
        if (finalAnalysis.observations.length > 0) {
            log(`   Observations: ${finalAnalysis.observations.slice(0, 2).join('; ')}${finalAnalysis.observations.length > 2 ? '...' : ''}`);
        }
        if (finalAnalysis.recommendations.length > 0) {
            log(`   Recommendations: ${finalAnalysis.recommendations.slice(0, 2).join('; ')}${finalAnalysis.recommendations.length > 2 ? '...' : ''}`);
        }
        console.log('');
        
        return finalAnalysis;

    } catch (error) {
        console.error('OpenAI API Error:', error.message);
        // Return fallback analysis
        return {
            detectedConditions: [],
            skinType: 'combination',
            confidence: 0.5,
            error: 'AI analysis failed, using user-selected conditions'
        };
    }
}

// Generate diet & lifestyle suggestions using OpenAI based on analysis
async function getLifestyleSuggestions(analysis, userDescription = '') {
    if (!openai) {
        console.log('⚠️  OpenAI client not initialized (API_KEY not set)');
        return [];
    }
    console.log('🔄 Generating lifestyle suggestions...');

    try {
        const systemPrompt = `You are a dermatology assistant. Given a skin analysis JSON and optional user description, produce up to 6 concise, practical diet and lifestyle suggestions tailored to the detected skin conditions and skin type. Keep suggestions short (one sentence each).`;

        const userPrompt = `Analysis: ${JSON.stringify(analysis)}\nUser description: "${(userDescription || '').replace(/\"/g, "'")}"\n\nProvide suggestions as a simple list, one per line.`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: 300,
            temperature: 0.2
        });

        let content = response.choices?.[0]?.message?.content || '';

        console.log(`📨 Raw OpenAI response:\n${content}\n`);

        // Simple approach: split by newlines and filter empty lines
        let suggestions = content
            .split('\n')
            .map(line => line.trim())
            .map(line => line.replace(/^[-•*\d.\)\s]+/, '').trim()) // Remove bullet points/numbers
            .filter(line => line.length > 5);

        console.log(`✅ Generated ${suggestions.length} suggestions from raw response`);
        suggestions.forEach((s, idx) => {
            console.log(`   ${idx + 1}. ${s}`);
        });

        return suggestions;

    } catch (error) {
        console.error('❌ Lifestyle suggestions error:', error?.message || error);
        return [];
    }
}

// Helper function to extract structured data from text when JSON parsing fails
function extractStructuredDataFromText(text) {
    const lowerText = (text || '').toLowerCase();

    // Extract detected conditions
    const detectedConditions = extractConditionsFromText(text);

    // Extract skin type
    const skinType = extractSkinTypeFromText(text);

    // Try to extract confidence score
    let confidence = 0.8;
    const confidenceMatch = text && text.match(/confidence[:\s]+([0-9.]+)/i);
    if (confidenceMatch) {
        confidence = parseFloat(confidenceMatch[1]) || confidence;
        if (confidence > 1) confidence = confidence / 100; // Convert percentage to decimal
    }

    // Extract observations (look for bullet points or numbered lists)
    const observations = [];
    const observationMatches = text && text.match(/(?:^|\n)[\s]*[-•*]\s*(.+)/gm);
    if (observationMatches) {
        observationMatches.forEach(match => {
            const obs = match.replace(/^[\s]*[-•*]\s*/, '').trim();
            if (obs) observations.push(obs);
        });
    }

    // Extract recommendations
    const recommendations = [];
    const recSection = text && text.match(/recommendations?[:\s]+([\s\S]*?)(?:\n\n|$)/i);
    if (recSection) {
        const recMatches = recSection[1].match(/(?:^|\n)[\s]*[-•*]\s*(.+)/gm);
        if (recMatches) {
            recMatches.forEach(match => {
                const rec = match.replace(/^[\s]*[-•*]\s*/, '').trim();
                if (rec) recommendations.push(rec);
            });
        }
    }

    return {
        detectedConditions: detectedConditions.length > 0 ? detectedConditions : [],
        skinType: skinType || 'combination',
        confidence: confidence,
        observations: observations.length > 0 ? observations : [String(text || '').substring(0, 500)],
        recommendations: recommendations.length > 0 ? recommendations : [],
        note: 'Analysis extracted from text response (JSON parsing failed)'
    };
}

// Helper function to extract conditions from text
function extractConditionsFromText(text) {
    const conditions = [];
    const conditionKeywords = {
        'acne': ['acne', 'pimple', 'breakout', 'blemish', 'comedone'],
        'dark-spots': ['dark spot', 'hyperpigmentation', 'pigmentation', 'melasma', 'age spot', 'sun spot'],
        'wrinkles': ['wrinkle', 'fine line', 'aging', 'age line', 'crow\'s feet'],
        'redness': ['redness', 'red', 'irritation', 'inflammation', 'rosacea', 'erythema'],
        'large-pores': ['large pore', 'pore', 'enlarged pore', 'open pore'],
        'uneven-texture': ['uneven', 'texture', 'rough', 'bumpy', 'roughness'],
        'dry': ['dry', 'dehydration', 'flaky', 'dryness', 'dehydrated'],
        'oily': ['oily', 'sebum', 'greasy', 'oiliness', 'excess oil'],
        'sensitive': ['sensitive', 'irritation', 'reactive', 'sensitivity']
    };

    const lowerText = text.toLowerCase();
    for (const [condition, keywords] of Object.entries(conditionKeywords)) {
        if (keywords.some(keyword => lowerText.includes(keyword))) {
            conditions.push(condition);
        }
    }

    return conditions;
}

// Helper function to extract skin type from text
function extractSkinTypeFromText(text) {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('oily')) return 'oily';
    if (lowerText.includes('dry')) return 'dry';
    if (lowerText.includes('sensitive')) return 'sensitive';
    if (lowerText.includes('combination')) return 'combination';
    if (lowerText.includes('normal')) return 'normal';
    return 'combination'; // default
}

// Calculate product match score (optimized for large databases)
function calculateMatchScore(product, userConditions, userDescription, verbose = false) {
    // Check cache first (conditions-specific, not budget-specific)
    const cacheKey = generateScoreCacheKey(product.id, userConditions);
    const cached = scoreCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.score;
    }

    let score = 0;
    const maxScore = 100;
    const weights = {
        beneficial: 12,      // Points per beneficial ingredient
        avoid: -25,          // Penalty per avoid ingredient
        conditionMatch: 15,  // Bonus if product targets condition
        nameMatch: 8,        // Bonus if condition in product name
        concentration: 5     // Bonus for ingredient in first 5 ingredients
    };

    // Get and preprocess product ingredients
    const ingredientsMeta = product.meta_data?.find(meta => 
        meta.key === 'ingredients' || meta.key === '_ingredients'
    );
    
    let ingredientSet;
    let ingredientsList = [];
    
    if (ingredientsMeta?.value) {
        const rawIngredients = typeof ingredientsMeta.value === 'string'
            ? ingredientsMeta.value
            : ingredientsMeta.value.join(', ');
        ingredientSet = preprocessIngredients(rawIngredients);
        ingredientsList = Array.from(ingredientSet);
    } else {
        // Fallback to description
        const descText = product.description?.toLowerCase() || '';
        ingredientSet = preprocessIngredients(descText);
        ingredientsList = Array.from(ingredientSet);
    }

    // Track matches for debugging
    let beneficialCount = 0;
    let avoidCount = 0;
    const matchedBeneficial = [];
    const matchedAvoid = [];

    // Process each user condition
    userConditions.forEach(condition => {
        const conditionData = INGREDIENT_DATABASE[condition];
        if (!conditionData) return;

        // Check beneficial ingredients with concentration bonus
        conditionData.beneficial.forEach((ingredient, index) => {
            if (hasIngredient(ingredientSet, ingredient)) {
                let points = weights.beneficial;
                
                // Bonus if ingredient appears in first 5 (higher concentration)
                if (ingredientsList.slice(0, 5).some(ing => ing.includes(normalizeIngredient(ingredient)))) {
                    points += weights.concentration;
                }
                
                score += points;
                beneficialCount++;
                matchedBeneficial.push(`${ingredient} (${condition})`);
            }
        });

        // Check ingredients to avoid (more severe penalty)
        conditionData.avoid.forEach(ingredient => {
            if (hasIngredient(ingredientSet, ingredient)) {
                score += weights.avoid;
                avoidCount++;
                matchedAvoid.push(`${ingredient} (${condition})`);
            }
        });

        // Check if product targets the condition
        const productNameLower = product.name.toLowerCase();
        const productDescLower = (product.short_description || product.description || '').toLowerCase();
        
        if (productNameLower.includes(condition.replace('-', ' ')) || 
            productNameLower.includes(condition)) {
            score += weights.nameMatch;
        }
        
        if (productDescLower.includes(condition.replace('-', ' ')) || 
            productDescLower.includes(condition)) {
            score += weights.conditionMatch;
        }
    });

    // Quality multiplier based on ingredient count (more complete formulas score better)
    if (ingredientsList.length > 10) {
        score *= 1.1; // 10% bonus for complete ingredient list
    }

    // Normalize score to 0-100 range
    score = Math.max(0, Math.min(maxScore, score));

    // Cache the result
    scoreCache.set(cacheKey, {
        score: Math.round(score),
        timestamp: Date.now()
    });

    // Only log if explicitly verbose and score is significant
    if (verbose && score >= 60) {
        log(`   🎯 ${product.name}: ${Math.round(score)}% (✅${beneficialCount} ❌${avoidCount})`);
    }

    return Math.round(score);
}

// Get relevant product categories based on conditions
function getRelevantCategories(conditions) {
    const categoryMap = {
        acne: ['acne treatment', 'spot treatment', 'cleanser', 'toner'],
        oily: ['oil control', 'mattifying', 'cleanser', 'toner'],
        dry: ['moisturizer', 'hydrating', 'face oil', 'serum'],
        sensitive: ['sensitive skin', 'gentle', 'soothing'],
        redness: ['redness relief', 'calming', 'anti-redness'],
        'dark-spots': ['brightening', 'dark spot corrector', 'vitamin c'],
        wrinkles: ['anti-aging', 'retinol', 'wrinkle treatment'],
        'large-pores': ['pore minimizer', 'toner', 'mask'],
        'uneven-texture': ['exfoliator', 'peeling', 'resurfacing']
    };

    let categories = new Set();
    conditions.forEach(condition => {
        if (categoryMap[condition]) {
            categoryMap[condition].forEach(cat => categories.add(cat));
        }
    });

    return Array.from(categories);
}

// Main analyze endpoint
app.post('/api/analyze', async (req, res) => {
    try {
        const { image, conditions, budget, description } = req.body;

        console.log('\n🔍 ========== NEW ANALYSIS REQUEST ==========');

        // Validate all inputs first
        console.log('✅ Validating input data...');
        
        // Validate conditions
        const conditionsValidation = validateConditions(conditions);
        if (!conditionsValidation.valid) {
            console.log(`❌ Conditions validation failed: ${conditionsValidation.error}`);
            return res.status(400).json({ error: conditionsValidation.error });
        }

        // Validate budget
        const budgetValidation = validateBudget(budget);
        if (!budgetValidation.valid) {
            console.log(`❌ Budget validation failed: ${budgetValidation.error}`);
            return res.status(400).json({ error: budgetValidation.error });
        }

        // Validate description
        const descriptionValidation = validateDescription(description);
        if (!descriptionValidation.valid) {
            console.log(`❌ Description validation failed: ${descriptionValidation.error}`);
            return res.status(400).json({ error: descriptionValidation.error });
        }

        // Validate image
        const imageValidation = validateImage(image);
        if (!imageValidation.valid) {
            console.log(`❌ Image validation failed: ${imageValidation.error}`);
            return res.status(400).json({ error: imageValidation.error });
        }

        log(`📋 User Conditions: ${conditions.join(', ')}`);
        log(`💰 Budget Range: ${budget || 'Any'}`);
        log(`📝 Description: ${description ? description.substring(0, 100) + '...' : 'None'}`);
        log(`🖼️  Image Provided: Yes (${(image.length * 3 / 4 / 1024).toFixed(2)}KB)`);

        // Validate that image is a human face
        console.log('🔎 Validating face image...');
        const faceValidation = await validateFaceSelfie(image);
        
        if (!faceValidation.isValid) {
            console.log(`❌ Face validation failed: ${faceValidation.message}`);
            return res.status(400).json({ 
                error: 'Invalid image - Please upload a clear photo of your face. The image must show a human face clearly.'
            });
        }
        console.log(`✅ Face validation passed: ${faceValidation.message}`);

        // Optimize image
        let optimizedImage;
        if (image) {
            optimizedImage = await optimizeImage(image);
        }

        // Analyze skin image using OpenAI
        let skinAnalysis = null;
        if (image && optimizedImage) {
            skinAnalysis = await analyzeSkinImage(optimizedImage);
            
            // Merge AI-detected conditions with user-selected conditions
            if (skinAnalysis.detectedConditions && skinAnalysis.detectedConditions.length > 0) {
                const aiConditions = skinAnalysis.detectedConditions;
                const combinedConditions = [...new Set([...conditions, ...aiConditions])];
                console.log('AI detected conditions:', aiConditions);
                console.log('Combined conditions:', combinedConditions);
                // Use combined conditions for better matching
                conditions.push(...aiConditions.filter(c => !conditions.includes(c)));
            }
        }

        // Get relevant categories
        const relevantCategories = getRelevantCategories(conditions);

        // Fetch ALL products from WooCommerce with budget-based caching
        // This way ALL users benefit from the same cache regardless of conditions
        let allProducts = [];
        const productCacheKey = generateProductCacheKey(budget);

        // Check product cache first (budget-based, NOT condition-based)
        const cachedProducts = productCache.get(productCacheKey);
        if (cachedProducts && Date.now() - cachedProducts.timestamp < PRODUCT_CACHE_TTL) {
            allProducts = cachedProducts.data;
            log(`\n📦 Using cached products: ${allProducts.length} products (Cache Hit!)`);
        } else {
            // Fetch fresh products from WooCommerce
            try {
                const fetchStartTime = Date.now();
                
                // Strategy: Fetch ALL skincare products once, cache globally
                // Then filter dynamically based on user conditions
                
                // Check category cache
                let categories = categoryCache.get('all_categories');
                if (!categories || Date.now() - categories.timestamp >= PRODUCT_CACHE_TTL) {
                    const categoryResponse = await WooCommerce.get('products/categories', {
                        per_page: 100
                    });
                    categories = { data: categoryResponse.data, timestamp: Date.now() };
                    categoryCache.set('all_categories', categories);
                }

                // Fetch ALL skincare products (not filtered by condition-specific categories)
                // This ensures all users benefit from the same cache
                const productsResponse = await WooCommerce.get('products', {
                    per_page: 100,
                    status: 'publish'
                });
                allProducts = productsResponse.data;

                // Remove duplicates by ID
                const uniqueProducts = Array.from(
                    new Map(allProducts.map(p => [p.id, p])).values()
                );
                allProducts = uniqueProducts;

                // Cache the results (shared across ALL condition combinations)
                productCache.set(productCacheKey, {
                    data: allProducts,
                    timestamp: Date.now()
                });

                const fetchTime = Date.now() - fetchStartTime;
                log(`\n📦 WooCommerce Products Fetched: ${allProducts.length} products (${fetchTime}ms, Cache Miss)`);

            } catch (error) {
                console.error('WooCommerce API Error:', error.response?.data || error.message);
                return res.status(500).json({ error: 'Failed to fetch products from WooCommerce' });
            }
        }

        // Filter by budget
        const budgetRange = BUDGET_RANGES[budget];
        const productsInBudget = allProducts.filter(product => {
            const price = parseFloat(product.price);
            return price >= budgetRange.min && price <= budgetRange.max;
        });

        log(`💰 Products in budget range ($${budgetRange.min}-$${budgetRange.max}): ${productsInBudget.length}`);

        // Calculate match scores efficiently with per-condition caching
        log(`\n⚡ Scoring ${productsInBudget.length} products for conditions: [${conditions.join(', ')}]`);
        const startTime = Date.now();
        let scoreCacheHits = 0;
        
        const productsWithScores = productsInBudget.map(product => {
            // Extract ingredients from meta_data
            const ingredientsMeta = product.meta_data?.find(meta =>
                meta.key === 'ingredients' || meta.key === '_ingredients'
            );
            
            const ingredients = ingredientsMeta?.value
                ? (typeof ingredientsMeta.value === 'string'
                    ? ingredientsMeta.value.split(',').map(i => i.trim())
                    : ingredientsMeta.value)
                : [];

            // Check if score is cached for this product + condition combination
            const scoreCacheKey = generateScoreCacheKey(product.id, conditions);
            const cachedScore = scoreCache.get(scoreCacheKey);
            if (cachedScore && Date.now() - cachedScore.timestamp < CACHE_TTL) {
                scoreCacheHits++;
            }

            // Calculate match score with optimized algorithm (uses cache internally)
            const matchScore = calculateMatchScore(product, conditions, description, false);

            return {
                ...product,
                matchScore,
                ingredients
            };
        });

        const processingTime = Date.now() - startTime;
        const cacheHitRate = ((scoreCacheHits / productsWithScores.length) * 100).toFixed(1);
        log(`✅ Scored ${productsWithScores.length} products in ${processingTime}ms (${(processingTime / productsWithScores.length).toFixed(1)}ms/product)`)
        log(`   💾 Score cache hits: ${scoreCacheHits}/${productsWithScores.length} (${cacheHitRate}% hit rate)`);

        // Filter out products with zero match score
        const productsWithScore = productsWithScores.filter(product => product.matchScore >= 40);
        
        log(`\n🔢 Match Score Filtering:`);
        log(`   Products before filtering: ${productsWithScores.length}`);
        log(`   Products with score > 0: ${productsWithScore.length}`);
        log(`   Products filtered out (score = 0): ${productsWithScores.length - productsWithScore.length}`);

        // Sort by match score
        productsWithScore.sort((a, b) => b.matchScore - a.matchScore);

        // Return top products (max 12, but only those with score > 0)
        const topProducts = productsWithScore.slice(0, 12);
        
        if (topProducts.length > 0) {
            log(`\n🏆 Top ${topProducts.length} Products (by match score, score > 0):`);
            topProducts.forEach((product, index) => {
                log(`   ${index + 1}. ${product.name} - Score: ${Math.round(product.matchScore)}% - Ingredients: ${product.ingredients.length > 0 ? product.ingredients.slice(0, 3).join(', ') + (product.ingredients.length > 3 ? '...' : '') : 'None'}`);
            });
        } else {
            log(`\n⚠️  No products found with match score > 0`);
            log(`   This might indicate:`);
            log(`   - Products don't have matching ingredients for selected conditions`);
            log(`   - Products are missing ingredient data`);
            log(`   - Try adjusting conditions or budget range`);
        }
        // end of processing

        // Ensure we have a finalAnalysis object to pass to suggestion generator
        const finalAnalysis = skinAnalysis || {
            detectedConditions: conditions || [],
            skinType: 'combination',
            confidence: 0.8,
            observations: [],
            recommendations: []
        };

        // Generate lifestyle suggestions (non-blocking if OpenAI not configured)
        let suggestions = [];
        try {
            suggestions = await getLifestyleSuggestions(finalAnalysis, description);
        } catch (e) {
            // already logged in in function
            suggestions = [];
        }

        // Reduce product payload to shape expected by the frontend
        const reducedProducts = topProducts.map(p => {
            // Clean and normalize ingredients (remove escaped quotes)
            const cleanedIngredients = (p.ingredients || []).map(ing => {
                if (typeof ing === 'string') {
                    return ing.replace(/^['"]|['"]$/g, '').trim();
                }
                return ing;
            }).filter(Boolean);

            const imagesArr = (p.images || []).map(img => {
                if (!img) return null;
                if (typeof img === 'string') return { src: img };
                return { src: img.src || img.url || img.thumbnail || '' };
            }).filter(Boolean);

            const firstImage = imagesArr.length > 0 ? (imagesArr[0].src || '') : (p.image || '');

            return {
                id: p.id,
                name: p.name || p.title || '',
                price: p.price || p.regular_price || null,
                matchScore: typeof p.matchScore === 'number' ? p.matchScore : (p.match_score || 0),
                categories: p.categories || p.category || [],
                ingredients: cleanedIngredients,
                permalink: p.permalink || p.url || p.link || '',
                url: p.url || p.permalink || p.link || '',
                images: imagesArr,
                image: firstImage,
                short_description: p.short_description || (p.description ? p.description.replace(/<[^>]+>/g, '').slice(0, 200) : '')
            };
        });

        res.json({
            success: true,
            skinAnalysis: finalAnalysis,
            products: reducedProducts,
            suggestions,
            totalFound: allProducts.length
        });

    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ error: 'Failed to analyze and fetch products' });
    }
});

// Add to Cart endpoint
app.post('/api/cart/add', async (req, res) => {
    try {
        const { productId } = req.body;

        // In a real implementation, you would:
        // 1. Get or create a cart for the user (using session/cookie)
        // 2. Add the product to WooCommerce cart via API

        // For now, return success (requires WooCommerce cart session management)
        res.json({
            success: true,
            message: 'Product added to cart'
        });

    } catch (error) {
        console.error('Add to cart error:', error);
        res.status(500).json({ error: 'Failed to add product to cart' });
    }
});

// Add to Wishlist endpoint
app.post('/api/wishlist/add', async (req, res) => {
    try {
        const { productId } = req.body;

        // In a real implementation with WooCommerce:
        // Use a wishlist plugin API or custom implementation
        // For example, YITH WooCommerce Wishlist has REST API endpoints

        res.json({
            success: true,
            message: 'Product added to wishlist'
        });

    } catch (error) {
        console.error('Add to wishlist error:', error);
        res.status(500).json({ error: 'Failed to add to wishlist' });
    }
});

// Remove from Wishlist endpoint
app.post('/api/wishlist/remove', async (req, res) => {
    try {
        const { productId } = req.body;

        res.json({
            success: true,
            message: 'Product removed from wishlist'
        });

    } catch (error) {
        console.error('Remove from wishlist error:', error);
        res.status(500).json({ error: 'Failed to remove from wishlist' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Skincare Analyzer API is running' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT} — API healthy at /api/health`);
});
