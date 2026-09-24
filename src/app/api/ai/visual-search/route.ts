import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import mongoose from 'mongoose';
import { ALL_PRODUCTS } from '@/data/products';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface VisualCatalogItem {
  _id: string;
  id?: string;
  slug?: string;
  title?: string;
  name?: string;
  category?: string;
  brand?: string;
  price?: number;
  discountPrice?: number;
  images?: string[];
  image?: string;
  stock?: number;
  description?: string;
  tags?: string[];
}

interface VisualMatchedItem {
  product: {
    _id: string;
    title: string;
    category?: string;
    brand?: string;
    price?: number;
    discountPrice?: number;
    images?: string[];
    stock?: number;
  };
  similarityScore: number;
  matchLabel: string;
  matchedFeatures: string[];
}

// In-Memory Visual Search Cache (Instant 0 Token replay for demo/viva)
interface CachedVisualResponse {
  data: Record<string, unknown>;
  timestamp: number;
}
const visualSearchCache = new Map<string, CachedVisualResponse>();
const VISUAL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes TTL

let cachedCatalogProducts: VisualCatalogItem[] = [];
let lastCatalogFetch = 0;
const CATALOG_TTL = 5 * 60 * 1000; // 5 mins in-memory catalog cache

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { imageUrl, language } = body;
    let { imageBase64 } = body;
    const isBn = language === 'bn';

    if (!imageBase64 && !imageUrl) {
      return NextResponse.json(
        { success: false, message: 'Image (base64 or URL) is required for visual search' },
        { status: 400 }
      );
    }

    // 🌐 1. If imageUrl is provided and imageBase64 is not, fetch and convert to base64
    if (!imageBase64 && imageUrl) {
      try {
        const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(4000) });
        if (imgRes.ok) {
          const arrayBuffer = await imgRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
          imageBase64 = `data:${mimeType};base64,${buffer.toString('base64')}`;
        }
      } catch {
        console.warn('Failed to fetch imageUrl for base64 conversion:', imageUrl);
      }
    }

    // Generate lightweight cache signature from image data or URL
    const cacheKey = imageBase64
      ? `${imageBase64.slice(0, 100)}_${imageBase64.slice(-100)}_${language || 'en'}`
      : `${imageUrl}_${language || 'en'}`;

    // ⚡ Tier 1: Check In-Memory Visual Cache (0 Token Cost)
    const cachedVisual = visualSearchCache.get(cacheKey);
    if (cachedVisual && Date.now() - cachedVisual.timestamp < VISUAL_CACHE_TTL) {
      return NextResponse.json({
        success: true,
        data: cachedVisual.data,
      });
    }

    // 🗄️ 2. Fetch live products from MongoDB Atlas (with fallback to ALL_PRODUCTS)
    let catalogProducts: VisualCatalogItem[] = [];
    if (cachedCatalogProducts.length > 0 && Date.now() - lastCatalogFetch < CATALOG_TTL) {
      catalogProducts = [...cachedCatalogProducts];
    } else {
      try {
        await connectToDatabase();
        const db = mongoose.connection.db;
        if (db) {
          const dbItems = await db.collection('products').find({ isActive: { $ne: false } }).toArray();
          if (dbItems && dbItems.length > 0) {
            catalogProducts = dbItems
              .filter((item) => item.title && !item.title.startsWith('sdfs') && !item.title.startsWith('ascasc'))
              .map((item) => ({
                ...item,
                _id: item._id ? String(item._id) : (item.id || item.slug || 'prod-id'),
              }));
          }
        }
      } catch {
        // Fallback to static dataset
      }

      // Merge static catalog products (Strict Deduplication by ID and Normalized Title)
      const existingIds = new Set(catalogProducts.map((p) => p._id));
      const existingTitles = new Set(
        catalogProducts.map((p) => (p.title || '').toLowerCase().trim())
      );
      for (const prod of ALL_PRODUCTS) {
        const prodTitle = (prod.title || '').toLowerCase().trim();
        if (!existingIds.has(prod._id) && !existingTitles.has(prodTitle)) {
          catalogProducts.push(prod);
          existingIds.add(prod._id);
          existingTitles.add(prodTitle);
        }
      }

      cachedCatalogProducts = catalogProducts;
      lastCatalogFetch = Date.now();
    }

    // Create concise catalog reference for AI prompt
    const catalogSummary = catalogProducts.slice(0, 35).map((p) => ({
      id: p._id,
      title: p.title || '',
      category: p.category,
      brand: p.brand,
      price: p.discountPrice || p.price,
      tags: p.tags || [],
    }));

    let aiMatchResult: {
      isProduct: boolean;
      detectedItem: string;
      detectedCategory: string;
      brand?: string;
      color?: string;
      keywords: string[];
      isCatalogAvailable: boolean;
      aiMessage: string;
      visualTags: string[];
      matchedProductIds: Array<{
        id: string;
        similarityScore: number;
        confidence?: string;
        matchedFeatures: string[];
      }>;
    } | null = null;

    // ⚡ 3. Multi-Key & Multi-Model Vision Cascade
    const rawApiKeyEnv = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '';
    const apiKeys = rawApiKeyEnv
      .split(/[,;\n]+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 10);

    if (apiKeys.length > 0 && imageBase64) {
      let mimeType = 'image/jpeg';
      let cleanBase64 = imageBase64;

      if (imageBase64.includes(';base64,')) {
        const parts = imageBase64.split(';base64,');
        const mimeMatch = parts[0].match(/:(.*?)$/);
        if (mimeMatch) mimeType = mimeMatch[1];
        cleanBase64 = parts[1];
      }

      const targetLanguageInstruction = isBn
        ? `CRITICAL LANGUAGE DIRECTIVE:
The current user interface language is BENGALI (বাংলা).
1. "detectedItem": MUST be written in natural, accurate Bengali (e.g. "স্মার্টওয়াচ / ঘড়ি", "মেকানিক্যাল কীবোর্ড", "ওয়্যারলেস হেডফোন", "টি-শার্ট", "লেদার ওয়ালেট", "সেলফি স্টিক ও ট্রাইপড", "মানুষের সেলফি / প্রতিকৃতি", "প্রাকৃতিক দৃশ্য").
2. "aiMessage": MUST be STRICTLY 100% NATURAL BENGALI (বাংলা).
3. "visualTags": MUST be in Bengali (e.g. ["স্মার্টওয়াচ", "ফিটনেস-ট্র্যাকার", "রিস্ট-ব্যান্ড"]).`
        : `CRITICAL LANGUAGE DIRECTIVE:
The current user interface language is ENGLISH.
1. "detectedItem": MUST be written in crisp, natural English (e.g. "Apple Watch Ultra / Smartwatch", "Mechanical Keyboard", "Wireless Headphones", "Cotton T-Shirt", "Leather Wallet", "Human Portrait / Selfie", "Nature Scenery").
2. "aiMessage": MUST be STRICTLY 100% PURE ENGLISH.
3. "visualTags": MUST be in English (e.g. ["smartwatch", "wearables", "fitness-tracker"]).`;

      const visionPrompt = `You are ShopNexus AI Vector Vision Engine - a high-accuracy multimodal visual recognition system for an e-commerce platform.

${targetLanguageInstruction}

ANALYSIS GUIDELINES:
1. Determine whether the image contains a COMMERCIAL PRODUCT / PURCHASABLE ITEM (e.g. watches, smartwatches, headphones, microphones, keyboards, mice, electronics, fashion apparel, shoes, bags, accessories, home items, gadgets, etc.):
   - If a person is wearing or holding a product (e.g., wrist watch, wearing headphones, holding a microphone or phone):
     -> Focus strictly on the PRODUCT in foreground! Set "isProduct": true.
   - If the image is PURELY a human face/selfie, portrait, pet/animal, nature landscape, building, document, or abstract background with NO distinct product:
     -> Set "isProduct": false.
     -> "detectedItem": Clear description in requested language (e.g. "মানুষের প্রতিকৃতি / সেলফি" or "Human Portrait / Selfie", "প্রাকৃতিক দৃশ্য" or "Nature Scenery").
     -> "aiMessage": In requested language, politely state what was detected, that it is not a commercial product, and invite them to explore store products below.
     -> "matchedProductIds": []

2. If "isProduct" is true:
   - Identify the exact product name/type ("detectedItem"), category ("detectedCategory"), brand if visible, and key search keywords in "keywords" (both English and Bengali terms, e.g. ["watch", "স্মার্টওয়াচ", "ultra", "apple"]).
   - Inspect the STORE CATALOG below.
   - If a direct match or strong similarity exists in the catalog:
     -> Set "isCatalogAvailable": true
     -> Add matched product ID(s) to "matchedProductIds" with similarityScore (0.80 to 0.98) and matchedFeatures.
     -> "aiMessage": Confirm the match clearly in requested language.
   - If the product is a REAL PRODUCT but NOT in our direct catalog (e.g. a specific drone, camera, vintage watch, or fashion item not in list):
     -> Set "isCatalogAvailable": false
     -> "matchedProductIds": []
     -> "aiMessage": In requested language, politely explain that "[detectedItem]" was recognized, but is currently out of stock / not in catalog, and that we will add it soon while presenting related alternatives below.

STORE CATALOG:
${JSON.stringify(catalogSummary, null, 2)}

OUTPUT SCHEMA (Respond ONLY with valid JSON, no markdown blocks):
{
  "isProduct": true,
  "detectedItem": "Name of the detected product or subject",
  "detectedCategory": "Category name (e.g. Wearables, Audio, Peripherals, Fashion, Electronics, General)",
  "brand": "Brand if known or empty",
  "color": "Color if identifiable",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "isCatalogAvailable": true,
  "aiMessage": "Pure natural message in requested language",
  "visualTags": ["tag1", "tag2", "tag3"],
  "matchedProductIds": [
    {
      "id": "product_id_from_catalog",
      "similarityScore": 0.95,
      "confidence": "high",
      "matchedFeatures": ["Feature 1", "Feature 2"]
    }
  ]
}`;

      const visionModels = [
        'gemini-2.5-flash',
        'gemini-flash-lite-latest',
        'gemini-2.0-flash',
        'gemini-1.5-flash',
      ];

      for (const apiKey of apiKeys) {
        if (aiMatchResult) break;

        for (const model of visionModels) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4500);

            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const geminiRes = await fetch(geminiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller.signal,
              body: JSON.stringify({
                contents: [
                  {
                    parts: [
                      { text: visionPrompt },
                      {
                        inline_data: {
                          mime_type: mimeType,
                          data: cleanBase64,
                        },
                      },
                    ],
                  },
                ],
                generationConfig: {
                  temperature: 0.1,
                  maxOutputTokens: 500,
                  responseMimeType: 'application/json',
                },
              }),
            });

            clearTimeout(timeoutId);

            if (geminiRes.ok) {
              const geminiData = await geminiRes.json();
              const rawText =
                geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

              if (rawText) {
                const cleanJson = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
                const parsed = JSON.parse(cleanJson);
                if (parsed.detectedItem) {
                  aiMatchResult = {
                    isProduct: parsed.isProduct !== false,
                    detectedItem: parsed.detectedItem,
                    detectedCategory: parsed.detectedCategory || 'General',
                    brand: parsed.brand || '',
                    color: parsed.color || '',
                    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
                    isCatalogAvailable: Boolean(parsed.isCatalogAvailable),
                    aiMessage: parsed.aiMessage || '',
                    visualTags: Array.isArray(parsed.visualTags) ? parsed.visualTags : [],
                    matchedProductIds: Array.isArray(parsed.matchedProductIds)
                      ? parsed.matchedProductIds
                      : [],
                  };
                  break;
                }
              }
            }
          } catch {
            // Try next model or key in cascade
          }
        }
      }
    }

    // 🎯 4. Smart Dynamic Catalog Match & Ranking Engine
    const isProduct = aiMatchResult ? aiMatchResult.isProduct : true;
    const detectedItemTitle = aiMatchResult?.detectedItem || (isBn ? 'শনাক্তকৃত পণ্য' : 'Detected Product');
    const detectedCategory = aiMatchResult?.detectedCategory || 'General';
    const queryVisualTags = aiMatchResult?.visualTags || [];
    const keywords = (aiMatchResult?.keywords || []).map((k: string) => k.toLowerCase().trim()).filter(Boolean);

    // Add detectedItem tokens to keywords
    detectedItemTitle.toLowerCase().split(/[\s,/-]+/).forEach((word: string) => {
      if (word.length > 2 && !keywords.includes(word)) {
        keywords.push(word);
      }
    });

    const finalMatchedItems: VisualMatchedItem[] = [];
    const seenMatchedIds = new Set<string>();

    if (isProduct) {
      // Step A: Check AI-selected direct IDs
      if (aiMatchResult && aiMatchResult.matchedProductIds.length > 0) {
        for (const aiMatch of aiMatchResult.matchedProductIds) {
          const fullProd = catalogProducts.find(
            (p) => p._id === aiMatch.id || p.id === aiMatch.id || p.slug === aiMatch.id
          );
          if (fullProd && !seenMatchedIds.has(fullProd._id)) {
            seenMatchedIds.add(fullProd._id);
            finalMatchedItems.push({
              product: {
                _id: fullProd._id,
                title: fullProd.title || fullProd.name || 'Product',
                category: fullProd.category,
                brand: fullProd.brand,
                price: fullProd.price,
                discountPrice: fullProd.discountPrice,
                images: fullProd.images || (fullProd.image ? [fullProd.image] : []),
                stock: fullProd.stock ?? 20,
              },
              similarityScore: Number(aiMatch.similarityScore) || 0.94,
              matchLabel: isBn ? 'সর্বোচ্চ মিল' : 'Direct Match',
              matchedFeatures: aiMatch.matchedFeatures?.length
                ? aiMatch.matchedFeatures
                : [fullProd.category || 'Product', fullProd.brand || 'Store Item'].filter(Boolean),
            });
          }
        }
      }

      // Step B: Multi-Keyword & Semantic Matching across Catalog
      if (finalMatchedItems.length === 0 && keywords.length > 0) {
        const scoredCandidates: Array<{ product: VisualCatalogItem; score: number }> = [];

        for (const prod of catalogProducts) {
          if (seenMatchedIds.has(prod._id)) continue;
          const prodTitle = (prod.title || prod.name || '').toLowerCase();
          const prodCat = (prod.category || '').toLowerCase();
          const prodBrand = (prod.brand || '').toLowerCase();
          const prodTags = (prod.tags || []).map((t) => t.toLowerCase());

          let score = 0;
          for (const kw of keywords) {
            if (prodTitle.includes(kw)) score += 3;
            if (prodCat.includes(kw)) score += 2;
            if (prodBrand.includes(kw)) score += 2;
            if (prodTags.some((t) => t.includes(kw))) score += 1.5;
          }

          if (detectedCategory && prodCat.includes(detectedCategory.toLowerCase())) {
            score += 1;
          }

          if (score >= 2) {
            scoredCandidates.push({ product: prod, score });
          }
        }

        // Sort candidates by highest match score
        scoredCandidates.sort((a, b) => b.score - a.score);

        scoredCandidates.slice(0, 3).forEach((item, idx) => {
          const fullProd = item.product;
          seenMatchedIds.add(fullProd._id);
          finalMatchedItems.push({
            product: {
              _id: fullProd._id,
              title: fullProd.title || fullProd.name || 'Product',
              category: fullProd.category,
              brand: fullProd.brand,
              price: fullProd.price,
              discountPrice: fullProd.discountPrice,
              images: fullProd.images || (fullProd.image ? [fullProd.image] : []),
              stock: fullProd.stock ?? 20,
            },
            similarityScore: Math.max(0.80, Math.min(0.96, 0.92 - idx * 0.05)),
            matchLabel: idx === 0 ? (isBn ? 'সরাসরি মিল' : 'Best Match') : (isBn ? 'সম্পর্কিত মিল' : 'Related Match'),
            matchedFeatures: [fullProd.category || 'Product', fullProd.brand || 'Featured'].filter(Boolean),
          });
        });
      }
    }

    // 🌟 5. Recommendations: "You May Also Like" / "আপনারা দেখতে পারেন"
    const recommendedItems: VisualMatchedItem[] = [];
    if (isProduct && finalMatchedItems.length > 0 && finalMatchedItems.length < 3) {
      const remainingSlots = 3 - finalMatchedItems.length;
      const unselectedCatalog = catalogProducts.filter((p) => !seenMatchedIds.has(p._id));
      const sameCatUnselected = unselectedCatalog.filter(
        (p) => p.category?.toLowerCase() === detectedCategory.toLowerCase()
      );
      const recommendationCandidates =
        sameCatUnselected.length >= remainingSlots ? sameCatUnselected : unselectedCatalog;

      recommendationCandidates.slice(0, remainingSlots).forEach((p) => {
        recommendedItems.push({
          product: {
            _id: p._id,
            title: p.title || p.name || 'Product',
            category: p.category,
            brand: p.brand,
            price: p.price,
            discountPrice: p.discountPrice,
            images: p.images || (p.image ? [p.image] : []),
            stock: p.stock ?? 20,
          },
          similarityScore: 0,
          matchLabel: isBn ? 'জনপ্রিয় পছন্দ' : 'Popular Pick',
          matchedFeatures: [p.category, p.brand].filter((item): item is string => Boolean(item)),
        });
      });
    }

    // 💡 6. Alternative Products when Product is Out of Stock / Not in Catalog (0 matches)
    let alternativeItems: VisualMatchedItem[] = [];
    if (isProduct && finalMatchedItems.length === 0) {
      const categoryProds = catalogProducts.filter(
        (p) => p.category?.toLowerCase() === detectedCategory.toLowerCase()
      );
      const candidateList = categoryProds.length >= 2 ? categoryProds : catalogProducts;
      
      alternativeItems = candidateList.slice(0, 4).map((p, idx) => ({
        product: {
          _id: p._id,
          title: p.title || p.name || 'Product',
          category: p.category,
          brand: p.brand,
          price: p.price,
          discountPrice: p.discountPrice,
          images: p.images || (p.image ? [p.image] : []),
          stock: p.stock ?? 15,
        },
        similarityScore: Math.max(0.75, 0.90 - idx * 0.05),
        matchLabel: isBn ? 'বিকল্প পছন্দ' : 'Alternative Pick',
        matchedFeatures: [p.category, p.brand].filter((item): item is string => Boolean(item)),
      }));
    }

    // 🌟 7. Popular Store Products for Non-Product Images (selfies, landscapes, etc.)
    if (!isProduct || (finalMatchedItems.length === 0 && recommendedItems.length === 0 && alternativeItems.length === 0)) {
      const topPicks = catalogProducts.slice(0, 4);
      topPicks.forEach((p) => {
        recommendedItems.push({
          product: {
            _id: p._id,
            title: p.title || p.name || 'Product',
            category: p.category,
            brand: p.brand,
            price: p.price,
            discountPrice: p.discountPrice,
            images: p.images || (p.image ? [p.image] : []),
            stock: p.stock ?? 20,
          },
          similarityScore: 0,
          matchLabel: isBn ? 'জনপ্রিয় পছন্দ' : 'Popular Pick',
          matchedFeatures: [p.category, p.brand].filter((item): item is string => Boolean(item)),
        });
      });
    }

    // Dynamic AI Message Formulation
    let aiMessage = aiMatchResult?.aiMessage || '';
    if (!aiMessage) {
      if (!isProduct) {
        aiMessage = isBn
          ? `শনাক্তকৃত বিষয়: "${detectedItemTitle}"। এটি বিক্রয়যোগ্য কোনো পণ্য নয়। অনুগ্রহ করে কোনো পণ্যের স্পষ্ট ছবি আপলোড করুন। নিচে আমাদের শপের ট্রেন্ডিং ও জনপ্রিয় পণ্যগুলো ঘুরে দেখতে পারেন:`
          : `Detected Subject: "${detectedItemTitle}". This does not appear to be a commercial product. Please upload a clear photo of an item. In the meantime, explore our top store products below:`;
      } else if (finalMatchedItems.length > 0) {
        aiMessage = isBn
          ? `আপনার ছবির সাথে আমাদের ক্যাটালগে থাকা "${finalMatchedItems[0].product.title}" পণ্যটি সফলভাবে শনাক্ত ও মিল করা হয়েছে।`
          : `We identified your uploaded image and directly matched it with "${finalMatchedItems[0].product.title}" from our catalog.`;
      } else {
        aiMessage = isBn
          ? `আমরা "${detectedItemTitle}" সফলভাবে শনাক্ত করেছি। দুঃখিত, এই পণ্যটি এই মুহূর্তে আমাদের স্টকে নেই, তবে আমরা শীঘ্রই এটি আমাদের ক্যাটালগে যুক্ত করব! নিচে আমাদের সম্পর্কিত ও বিকল্প পণ্যগুলো দেখতে পারেন:`
          : `We identified "${detectedItemTitle}". While this exact item is currently out of stock, we are adding it soon! Check out related products below:`;
      }
    }

    const responsePayload = {
      isProduct,
      categoryType: isProduct ? 'product' : 'non_product',
      detectedCategory,
      detectedItem: detectedItemTitle,
      isGadget: isProduct, // backwards compatibility
      isCatalogAvailable: finalMatchedItems.length > 0,
      aiMessage,
      queryVisualTags: queryVisualTags.length > 0 ? queryVisualTags : ['visual-search', 'ai-vision'],
      matchedItems: finalMatchedItems,
      recommendedItems,
      alternativeItems,
    };

    // Cache the visual response if AI processed it
    if (aiMatchResult) {
      visualSearchCache.set(cacheKey, {
        data: responsePayload,
        timestamp: Date.now(),
      });
    }

    return NextResponse.json({
      success: true,
      data: responsePayload,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to process visual search request';
    console.error('AI Visual Search Endpoint Error:', error);
    return NextResponse.json(
      {
        success: false,
        message,
      },
      { status: 500 }
    );
  }
}
