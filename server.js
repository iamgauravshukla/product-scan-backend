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

// Ingredient Database - Maps skin conditions to beneficial/harmful ingredients
const INGREDIENT_DATABASE = {
    acne: {
        beneficial: ['salicylic acid', 'benzoyl peroxide', 'niacinamide', 'tea tree', 'zinc', 'sulfur'],
        avoid: ['coconut oil', 'cocoa butter', 'palm oil', 'isopropyl myristate']
    },
    oily: {
        beneficial: ['niacinamide', 'salicylic acid', 'clay', 'charcoal', 'witch hazel', 'zinc'],
        avoid: ['mineral oil', 'petrolatum', 'silicones', 'heavy oils']
    },
    dry: {
        beneficial: ['hyaluronic acid', 'glycerin', 'ceramides', 'squalane', 'shea butter', 'jojoba oil'],
        avoid: ['alcohol denat', 'fragrance', 'sulfates', 'high pH cleansers']
    },
    sensitive: {
        beneficial: ['centella asiatica', 'aloe vera', 'oat', 'chamomile', 'allantoin', 'bisabolol'],
        avoid: ['fragrance', 'essential oils', 'alcohol', 'retinol', 'high concentrations of acids']
    },
    redness: {
        beneficial: ['centella asiatica', 'niacinamide', 'azelaic acid', 'green tea', 'licorice root'],
        avoid: ['fragrance', 'menthol', 'eucalyptus', 'high concentrations of vitamin c']
    },
    'dark-spots': {
        beneficial: ['vitamin c', 'niacinamide', 'kojic acid', 'alpha arbutin', 'licorice root', 'azelaic acid'],
        avoid: ['harsh scrubs', 'fragrance']
    },
    wrinkles: {
        beneficial: ['retinol', 'peptides', 'vitamin c', 'hyaluronic acid', 'niacinamide', 'coenzyme q10'],
        avoid: ['fragrance', 'alcohol denat']
    },
    'large-pores': {
        beneficial: ['niacinamide', 'salicylic acid', 'retinol', 'clay masks', 'azelaic acid'],
        avoid: ['heavy oils', 'silicones']
    },
    'uneven-texture': {
        beneficial: ['glycolic acid', 'lactic acid', 'retinol', 'enzyme exfoliants', 'niacinamide'],
        avoid: ['harsh scrubs', 'fragrance']
    }
};

// Budget ranges for filtering
const BUDGET_RANGES = {
    low: { min: 0, max: 20 },
    mid: { min: 20, max: 50 },
    high: { min: 50, max: 100 },
    luxury: { min: 100, max: 999999 }
};

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
        
        // Log OpenAI raw response
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
                console.log(JSON.stringify(analysis, null, 2));
            }
            
        } catch (parseError) {
            // If all JSON parsing strategies fail, extract information from text
            console.warn('\n⚠️ Failed to parse OpenAI response as JSON, extracting from text');
            console.warn('Parse error:', parseError.message);
            console.warn('Response preview (first 300 chars):', analysisText.substring(0, 300));
            console.warn('Full response length:', analysisText.length);
            
            // Try to extract structured data from text using regex
            analysis = extractStructuredDataFromText(analysisText);
            console.log('\n📝 Extracted analysis from text:');
            console.log(JSON.stringify({
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
        
        console.log('\n📋 Final AI Analysis Summary:');
        console.log(`   Detected Conditions: ${finalAnalysis.detectedConditions.length > 0 ? finalAnalysis.detectedConditions.join(', ') : 'None'}`);
        console.log(`   Skin Type: ${finalAnalysis.skinType}`);
        console.log(`   Confidence: ${(finalAnalysis.confidence * 100).toFixed(1)}%`);
        if (finalAnalysis.observations.length > 0) {
            console.log(`   Observations: ${finalAnalysis.observations.slice(0, 2).join('; ')}${finalAnalysis.observations.length > 2 ? '...' : ''}`);
        }
        if (finalAnalysis.recommendations.length > 0) {
            console.log(`   Recommendations: ${finalAnalysis.recommendations.slice(0, 2).join('; ')}${finalAnalysis.recommendations.length > 2 ? '...' : ''}`);
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

// Helper function to extract structured data from text when JSON parsing fails
function extractStructuredDataFromText(text) {
    const lowerText = text.toLowerCase();
    
    // Extract detected conditions
    const detectedConditions = extractConditionsFromText(text);
    
    // Extract skin type
    const skinType = extractSkinTypeFromText(text);
    
    // Try to extract confidence score
    let confidence = 0.8;
    const confidenceMatch = text.match(/confidence[:\s]+([0-9.]+)/i);
    if (confidenceMatch) {
        confidence = parseFloat(confidenceMatch[1]);
        if (confidence > 1) confidence = confidence / 100; // Convert percentage to decimal
    }
    
    // Extract observations (look for bullet points or numbered lists)
    const observations = [];
    const observationMatches = text.match(/(?:^|\n)[\s]*[-•*]\s*(.+)/gm);
    if (observationMatches) {
        observationMatches.forEach(match => {
            const obs = match.replace(/^[\s]*[-•*]\s*/, '').trim();
            if (obs) observations.push(obs);
        });
    }
    
    // Extract recommendations
    const recommendations = [];
    const recSection = text.match(/recommendations?[:\s]+([\s\S]*?)(?:\n\n|$)/i);
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
        skinType: skinType,
        confidence: confidence,
        observations: observations.length > 0 ? observations : [text.substring(0, 500)],
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

// Calculate product match score
function calculateMatchScore(product, userConditions, userDescription, verbose = false) {
    let score = 0;
    const maxScore = 100;

    // Get product ingredients from meta_data
    const ingredientsMeta = product.meta_data?.find(meta => meta.key === 'ingredients' || meta.key === '_ingredients');
    const productIngredients = ingredientsMeta
        ? ingredientsMeta.value.toLowerCase()
        : product.description?.toLowerCase() || '';

    // Check for beneficial ingredients
    let beneficialCount = 0;
    let avoidCount = 0;
    const matchedBeneficial = [];
    const matchedAvoid = [];

    userConditions.forEach(condition => {
        const conditionData = INGREDIENT_DATABASE[condition];
        if (!conditionData) return;

        // Check beneficial ingredients
        conditionData.beneficial.forEach(ingredient => {
            if (productIngredients.includes(ingredient.toLowerCase())) {
                beneficialCount++;
                matchedBeneficial.push(`${ingredient} (for ${condition})`);
            }
        });

        // Check ingredients to avoid
        conditionData.avoid.forEach(ingredient => {
            if (productIngredients.includes(ingredient.toLowerCase())) {
                avoidCount++;
                matchedAvoid.push(`${ingredient} (avoid for ${condition})`);
            }
        });
    });

    // Calculate score
    score += (beneficialCount * 15); // Up to 15 points per beneficial ingredient
    score -= (avoidCount * 20); // Penalty for ingredients to avoid

    // Check if product description mentions user's concerns
    const descriptionLower = userDescription.toLowerCase();
    userConditions.forEach(condition => {
        if (productIngredients.includes(condition) || product.name.toLowerCase().includes(condition)) {
            score += 10;
        }
    });

    // Normalize score
    score = Math.max(0, Math.min(maxScore, score));

    // Log matching details if verbose
    if (verbose && (matchedBeneficial.length > 0 || matchedAvoid.length > 0)) {
        console.log(`   🎯 Match Score Calculation for "${product.name}":`);
        console.log(`      Score: ${Math.round(score)}%`);
        if (matchedBeneficial.length > 0) {
            console.log(`      ✅ Beneficial matches (${beneficialCount}): ${matchedBeneficial.join(', ')}`);
        }
        if (matchedAvoid.length > 0) {
            console.log(`      ❌ Avoid matches (${avoidCount}): ${matchedAvoid.join(', ')}`);
        }
    }

    return score;
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
        console.log(`📋 User Conditions: ${conditions.join(', ')}`);
        console.log(`💰 Budget Range: ${budget}`);
        console.log(`📝 Description: ${description ? description.substring(0, 100) + '...' : 'None'}`);
        console.log(`🖼️  Image Provided: ${image ? 'Yes' : 'No'}`);

        // Validate input
        if (!conditions || conditions.length === 0) {
            return res.status(400).json({ error: 'Please select at least one skin condition' });
        }

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

        // Fetch products from WooCommerce
        let allProducts = [];

        // First, try to get products from relevant categories
        try {
            const categoryResponse = await WooCommerce.get('products/categories', {
                per_page: 100
            });

            const matchingCategories = categoryResponse.data.filter(cat =>
                relevantCategories.some(relevantCat =>
                    cat.name.toLowerCase().includes(relevantCat.toLowerCase())
                )
            );

            // Fetch products from matching categories
            for (const category of matchingCategories) {
                const productsResponse = await WooCommerce.get('products', {
                    category: category.id,
                    per_page: 20,
                    status: 'publish'
                });
                allProducts = allProducts.concat(productsResponse.data);
            }

            // If no products found in categories, fetch all skincare products
            if (allProducts.length === 0) {
                const productsResponse = await WooCommerce.get('products', {
                    per_page: 50,
                    status: 'publish'
                });
                allProducts = productsResponse.data;
            }

            console.log(`\n📦 WooCommerce Products Fetched: ${allProducts.length} products`);

        } catch (error) {
            console.error('WooCommerce API Error:', error.response?.data || error.message);
            return res.status(500).json({ error: 'Failed to fetch products from WooCommerce' });
        }

        // Filter by budget
        const budgetRange = BUDGET_RANGES[budget];
        const productsInBudget = allProducts.filter(product => {
            const price = parseFloat(product.price);
            return price >= budgetRange.min && price <= budgetRange.max;
        });

        console.log(`💰 Products in budget range ($${budgetRange.min}-$${budgetRange.max}): ${productsInBudget.length}`);

        // Calculate match scores and add ingredients
        const productsWithScores = productsInBudget.map((product, index) => {
            // Extract ingredients from meta_data
            const ingredientsMeta = product.meta_data?.find(meta =>
                meta.key === 'ingredients' || meta.key === '_ingredients'
            );
            
            const ingredients = ingredientsMeta
                ? ingredientsMeta.value.split(',').map(i => i.trim())
                : [];

            // Log ingredients for each product
            if (ingredientsMeta) {
                console.log(`\n✅ Product ${index + 1}: ${product.name} (ID: ${product.id})`);
                console.log(`   Ingredients Key: ${ingredientsMeta.key}`);
                console.log(`   Ingredients Raw: ${ingredientsMeta.value}`);
                console.log(`   Ingredients Parsed: [${ingredients.join(', ')}]`);
                console.log(`   Ingredients Count: ${ingredients.length}`);
            } else {
                console.log(`\n❌ Product ${index + 1}: ${product.name} (ID: ${product.id})`);
                console.log(`   ⚠️  No ingredients found in meta_data`);
                if (product.meta_data && product.meta_data.length > 0) {
                    const availableKeys = product.meta_data.map(m => m.key).join(', ');
                    console.log(`   Available meta_data keys: ${availableKeys}`);
                } else {
                    console.log(`   No meta_data found for this product`);
                }
                if (product.description) {
                    console.log(`   Description preview: ${product.description.substring(0, 100)}...`);
                }
            }

            const matchScore = calculateMatchScore(product, conditions, description, true); // verbose logging

            return {
                ...product,
                matchScore,
                ingredients
            };
        });

        // Summary log
        const productsWithIngredients = productsWithScores.filter(p => p.ingredients && p.ingredients.length > 0);
        const productsWithoutIngredients = productsWithScores.filter(p => !p.ingredients || p.ingredients.length === 0);
        
        console.log(`\n📊 Ingredients Summary:`);
        console.log(`   Products WITH ingredients: ${productsWithIngredients.length} ✅`);
        console.log(`   Products WITHOUT ingredients: ${productsWithoutIngredients.length} ❌`);
        console.log(`   Total products processed: ${productsWithScores.length}`);

        // Filter out products with zero match score
        const productsWithScore = productsWithScores.filter(product => product.matchScore > 70);
        
        console.log(`\n🔢 Match Score Filtering:`);
        console.log(`   Products before filtering: ${productsWithScores.length}`);
        console.log(`   Products with score > 0: ${productsWithScore.length}`);
        console.log(`   Products filtered out (score = 0): ${productsWithScores.length - productsWithScore.length}`);

        // Sort by match score
        productsWithScore.sort((a, b) => b.matchScore - a.matchScore);

        // Return top products (max 12, but only those with score > 0)
        const topProducts = productsWithScore.slice(0, 12);
        
        if (topProducts.length > 0) {
            console.log(`\n🏆 Top ${topProducts.length} Products (by match score, score > 0):`);
            topProducts.forEach((product, index) => {
                console.log(`   ${index + 1}. ${product.name} - Score: ${Math.round(product.matchScore)}% - Ingredients: ${product.ingredients.length > 0 ? product.ingredients.slice(0, 3).join(', ') + (product.ingredients.length > 3 ? '...' : '') : 'None'}`);
            });
        } else {
            console.log(`\n⚠️  No products found with match score > 0`);
            console.log(`   This might indicate:`);
            console.log(`   - Products don't have matching ingredients for selected conditions`);
            console.log(`   - Products are missing ingredient data`);
            console.log(`   - Try adjusting conditions or budget range`);
        }
        console.log('');

        res.json({
            success: true,
            skinAnalysis,
            products: topProducts,
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
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`\n📡 Available API Endpoints:`);
    console.log(`   GET  http://localhost:${PORT}/api/health - Health check`);
    console.log(`   GET  http://localhost:${PORT}/api/test/products - Test product ingredients`);
    console.log(`   POST http://localhost:${PORT}/api/analyze - Analyze skin and get recommendations`);
    console.log(`   POST http://localhost:${PORT}/api/cart/add - Add product to cart`);
    console.log(`   POST http://localhost:${PORT}/api/wishlist/add - Add to wishlist`);
    console.log(`   POST http://localhost:${PORT}/api/wishlist/remove - Remove from wishlist`);
    console.log(`\n`);
});
