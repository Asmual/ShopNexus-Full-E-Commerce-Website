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

// In-Memory Visual Search Cache (0 Token Cost for repeated image searches in demos/viva)
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

    // 🗄️ 2. Fetch live products from MongoDB Atlas (with fallback to cached or ALL_PRODUCTS)
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
        // Fallback to in-memory datasets
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
    const catalogSummary = catalogProducts.slice(0, 30).map((p) => ({
      id: p._id,
      title: p.title || '',
      category: p.category,
      brand: p.brand,
      price: p.discountPrice || p.price,
      tags: p.tags || [],
      description: (p.description || '').slice(0, 150),
    }));

    let aiMatchResult: {
      categoryType: 'human_or_selfie' | 'tech_gadget' | 'non_tech_object' | 'screenshot_or_ui';
      detectedCategory?: string;
      detectedItem: string;
      isGadget: boolean;
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
1. "detectedItem": MUST be written in natural, accurate Bengali (e.g. "কিউ০৭ ব্লুটুথ সেলফি স্টিক ও ট্রাইপড", "ওয়্যারলেস মাইক্রোফোন", "অ্যাপল আইফোন ও ম্যাগসেফ কেস", "মেকানিক্যাল কীবোর্ড", "স্মার্টওয়াচ", "নয়েজ-ক্যানসেলিং হেডফোন").
2. "aiMessage": MUST be STRICTLY 100% PURE BENGALI (বাংলা). Under NO circumstances should you output English sentences, mixed text, or slash translations like "/ Hello...". Output only clean Bengali sentences.
3. "visualTags": MUST be in Bengali (e.g. ["সেলফি-স্টিক", "ট্রাইপড", "মোবাইল-অ্যাকসেসরি"] or ["মাইক্রোফোন", "অডিও-রেকর্ড", "ভয়েস"]).`
        : `CRITICAL LANGUAGE DIRECTIVE:
The current user interface language is ENGLISH.
1. "detectedItem": MUST be written in crisp, professional English (e.g. "Q07 Bluetooth Selfie Stick & Tripod", "Wireless Lavalier Microphone", "Apple iPhone with MagSafe Case", "Mechanical Keyboard", "Smartwatch").
2. "aiMessage": MUST be STRICTLY 100% PURE ENGLISH. DO NOT include any Bengali words or slash translations.
3. "visualTags": MUST be in English (e.g. ["selfie-stick", "tripod", "creator-gear"] or ["microphone", "wireless-audio"]).`;

      const visionPrompt = `You are ShopNexus AI Vector Vision Engine - a specialist in multimodal computer vision for tech gadgets, electronics, mechanical keyboards, audiophile headphones, smartwatches, gaming peripherals, smartphones, and accessories.

${targetLanguageInstruction}

CRITICAL OCR & PRODUCT BOX DIRECTIVE:
If a person is holding a product box, retail packaging, or electronic device in front of the camera (e.g. "Wireless Microphone", "F11-2", "Lavalier Microphone", "Transmitter/Receiver", "Earbuds", "Mechanical Keyboard"):
1. ALWAYS prioritize and focus on the gadget/box being presented in the foreground, completely ignoring the human background!
2. Read all visible text printed on the box/device (e.g. "F11-2", "Wireless Microphone", "无线收音麦克风", "Lavalier", "Gaming Mouse", etc.).
3. If the box/device mentions or depicts a microphone, wireless mic, or audio gear:
   - "detectedCategory" MUST be "Audio"
   - "detectedItem" MUST be "ওয়্যারলেস মাইক্রোফোন" (or specific model in Bengali) when language is Bengali, or "Wireless Lavalier Microphone" when language is English.
   - "visualTags" MUST include ["মাইক্রোফোন", "ওয়্যারলেস-অডিও", "ল্যাভালিয়ার"] (or English equivalents).
   - "categoryType" MUST be "tech_gadget" and "isGadget": true.

Analyze the uploaded image with high precision across 3 possible cases:

Case A: The image shows a HUMAN, SELFIE, FACE, PORTRAIT, PET, SCENERY, RANDOM NON-TECH OBJECT (food, clothes, furniture), or CODE/SCREENSHOT without any tech gadget box held in hand.
- categoryType: "human_or_selfie" | "non_tech_object" | "screenshot_or_ui"
- isGadget: false
- isCatalogAvailable: false
- detectedCategory: "General"
- detectedItem: Clear description of the subject in the required language.
- aiMessage: Polite single-language explanation that ShopNexus is a premium tech gadget store and this is not a tech gadget.
- visualTags: Relevant single-language tags.
- matchedProductIds: []

Case B: The image shows a TECH GADGET / ELECTRONICS PRODUCT that MATCHES or IS VERY SIMILAR TO an item in the ShopNexus Catalog below (e.g. Mechanical Keyboard, Sony/Bose Headphones, Apple AirPods Max, Smartwatch, Gaming Mouse, Studio Mic, Smart Glasses).
- categoryType: "tech_gadget"
- isGadget: true
- isCatalogAvailable: true
- detectedCategory: One of "Wearables" | "Audio" | "Peripherals" | "Gaming" | "Creator Gear" | "Smart Home" | "Electronics"
- detectedItem: Specific gadget name with brand/model if visible in the required language.
- aiMessage: Positive single-language match explanation.
- visualTags: 3 to 5 relevant technical tags in the required language.
- matchedProductIds: Top 1-3 matching catalog IDs with similarityScore (0.85 to 0.99), confidence ("high" | "exact"), and matchedFeatures.

Case C: The image shows a REAL TECH GADGET / DEVICE that is NOT DIRECTLY STOCKED in the ShopNexus Catalog (e.g. Wireless Lavalier Microphone / F11-2, Selfie Stick / Tripod, Smartphone / iPhone with MagSafe Case, Drone, DSLR Camera, Tablet, VR Headset, Power Bank).
- categoryType: "tech_gadget"
- isGadget: true
- isCatalogAvailable: false
- detectedCategory: Closest related category ("Audio" for all microphones/recorders, "Creator Gear" for tripods/lights, "Peripherals", "Wearables", "Gaming", "Smart Home", or "Electronics")
- detectedItem: Specific name of the gadget / device in the required language (e.g. "ওয়্যারলেস মাইক্রোফোন" / "Wireless Lavalier Microphone", "Q07 Bluetooth Selfie Stick & Tripod").
- aiMessage: Notice in the required language explaining that this specific gadget model was recognized, but is currently not in direct inventory, with best alternative tech recommendations provided below.
- visualTags: 3 to 5 descriptive tags in the required language.
- matchedProductIds: []

SHOPNEXUS CATALOG:
${JSON.stringify(catalogSummary, null, 2)}

OUTPUT REQUIREMENT:
Respond ONLY with a valid JSON object matching this schema without markdown codeblocks or extra text:
{
  "categoryType": "human_or_selfie" | "tech_gadget" | "non_tech_object" | "screenshot_or_ui",
  "detectedCategory": "Wearables" | "Audio" | "Peripherals" | "Gaming" | "Creator Gear" | "Smart Home" | "Electronics",
  "detectedItem": "Accurate name of the detected gadget or subject",
  "isGadget": true/false,
  "isCatalogAvailable": true/false,
  "aiMessage": "Informative message strictly in requested language",
  "visualTags": ["tag1", "tag2", "tag3"],
  "matchedProductIds": [
    {
      "id": "catalog_product_id",
      "similarityScore": 0.95,
      "confidence": "high",
      "matchedFeatures": ["Feature 1", "Feature 2"]
    }
  ]
}`;

      const visionModels = [
        'gemini-3.6-flash',
        'gemini-3.7-flash',
        'gemini-3.8-flash',
        'gemini-flash-latest',
        'gemini-3.5-flash',
      ];

      for (const apiKey of apiKeys) {
        if (aiMatchResult) break;

        for (const model of visionModels) {
          if (aiMatchResult) break;
          try {
            const geminiRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [
                    {
                      role: 'user',
                      parts: [
                        {
                          inlineData: {
                            mimeType: mimeType,
                            data: cleanBase64,
                          },
                        },
                        {
                          text: visionPrompt,
                        },
                      ],
                    },
                  ],
                  generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 512,
                    thinkingConfig: {
                      thinkingBudget: 0,
                    },
                    responseMimeType: 'application/json',
                  },
                }),
                signal: AbortSignal.timeout(6000),
              }
            );

            if (geminiRes.ok) {
              const geminiJson = await geminiRes.json();
              const textResponse = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (textResponse) {
                try {
                  const cleaned = textResponse.replace(/```json|```/g, '').trim();
                  const parsed = JSON.parse(cleaned);
                  if (parsed.detectedItem) {
                    aiMatchResult = parsed;
                    break;
                  }
                } catch {
                  console.warn('JSON parse error from vision model:', textResponse);
                }
              }
            }
          } catch (modelErr) {
            console.warn(`Vision model attempt (${model}) error:`, modelErr);
          }
        }
      }
    }

    // 🎯 4. Build Final Matched Products List & Category Inference
    const finalMatchedItems: VisualMatchedItem[] = [];
    let detectedItemTitle = aiMatchResult?.detectedItem || (isBn ? 'শনাক্তকৃত গ্যাজেট' : 'Detected Tech Gadget');
    let queryVisualTags: string[] = aiMatchResult?.visualTags || [];
    const categoryType = aiMatchResult?.categoryType || 'tech_gadget';
    let isGadget = aiMatchResult?.isGadget ?? (categoryType === 'tech_gadget');
    const aiMessage = aiMatchResult?.aiMessage || '';
    let detectedCategory = aiMatchResult?.detectedCategory || '';

    // Smart Category & Subtype Inference
    const lowerDetection = `${detectedItemTitle} ${queryVisualTags.join(' ')} ${aiMessage}`.toLowerCase();
    const isMicrophone =
      lowerDetection.includes('microphone') ||
      lowerDetection.includes('মাইক্রোফোন') ||
      lowerDetection.includes('মাইক') ||
      lowerDetection.includes('mic') ||
      lowerDetection.includes('lavalier') ||
      lowerDetection.includes('podcast') ||
      lowerDetection.includes('vocal') ||
      lowerDetection.includes('f11') ||
      lowerDetection.includes('k9') ||
      lowerDetection.includes('k8') ||
      lowerDetection.includes('wireless mic') ||
      lowerDetection.includes('sound recording');

    const isSelfieOrTripod =
      (lowerDetection.includes('selfie') || lowerDetection.includes('tripod') || lowerDetection.includes('stick') || lowerDetection.includes('gimbal') || lowerDetection.includes('mount') || lowerDetection.includes('সেলফি') || lowerDetection.includes('ট্রাইপড')) &&
      !isMicrophone;

    const isHeadphonesOrSpeakers =
      (lowerDetection.includes('headphone') || lowerDetection.includes('earphone') || lowerDetection.includes('earbud') || lowerDetection.includes('speaker') || lowerDetection.includes('headset') || lowerDetection.includes('airpod') || lowerDetection.includes('হেডফোন')) &&
      !isMicrophone;

    const isWatchOrWearable =
      lowerDetection.includes('watch') || lowerDetection.includes('wearable') || lowerDetection.includes('fitness') || lowerDetection.includes('band') || lowerDetection.includes('tracker') || lowerDetection.includes('glasses') || lowerDetection.includes('স্মার্টওয়াচ');

    const isKeyboardOrMouse =
      lowerDetection.includes('keyboard') || lowerDetection.includes('mouse') || lowerDetection.includes('keycap') || lowerDetection.includes('desk') || lowerDetection.includes('peripheral') || lowerDetection.includes('কীবোর্ড') || lowerDetection.includes('মাউস');

    const isCameraOrCreator =
      (lowerDetection.includes('camera') || lowerDetection.includes('stream') || lowerDetection.includes('light') || lowerDetection.includes('lens') || lowerDetection.includes('dji') || isSelfieOrTripod) &&
      !isMicrophone;

    // Strict category resolution: Microphone MUST ALWAYS be 'Audio'
    if (isMicrophone) {
      detectedCategory = 'Audio';
    } else if (isHeadphonesOrSpeakers) {
      detectedCategory = 'Audio';
    } else if (isSelfieOrTripod || isCameraOrCreator) {
      detectedCategory = 'Creator Gear';
    } else if (isWatchOrWearable) {
      detectedCategory = 'Wearables';
    } else if (isKeyboardOrMouse) {
      detectedCategory = 'Peripherals';
    } else if (lowerDetection.includes('game') || lowerDetection.includes('controller') || lowerDetection.includes('console') || lowerDetection.includes('joystick')) {
      detectedCategory = 'Gaming';
    } else if (lowerDetection.includes('home') || lowerDetection.includes('smart bulb') || lowerDetection.includes('vacuum') || lowerDetection.includes('router')) {
      detectedCategory = 'Smart Home';
    } else if (!detectedCategory || detectedCategory === 'General') {
      detectedCategory = isGadget ? 'Audio' : 'General';
    }

    // Direct Match Validation (Must Strictly Match Product Type)
    // IMPORTANT: Selfie Sticks and unstocked items must NEVER match Headphones!
    if (aiMatchResult && isGadget && !isSelfieOrTripod && Array.isArray(aiMatchResult.matchedProductIds) && aiMatchResult.matchedProductIds.length > 0) {
      let matchIdx = 0;
      for (const match of aiMatchResult.matchedProductIds) {
        const fullProd = catalogProducts.find(
          (p) => p._id === match.id || p.id === match.id || p.slug === match.id
        );
        if (fullProd) {
          const prodTitleLower = (fullProd.title || fullProd.name || '').toLowerCase();

          // Strict type guard: A microphone query must only match genuine audio microphones, not headphones, smart home mugs, or mice!
          const isProdAudio = (fullProd.category || '').toLowerCase() === 'audio';
          const isProdMic = /\b(mic|mics|microphone|microphones|lavalier|podcast|sm7b|mv7|shure|condenser)\b/i.test(prodTitleLower);

          if (isMicrophone && (!isProdAudio || !isProdMic)) {
            continue;
          }
          // A headphone query must only match headphones, not microphones or speakers!
          if (isHeadphonesOrSpeakers && (isProdMic || prodTitleLower.includes('microphone'))) {
            continue;
          }

          const dynamicScore = match.similarityScore
            ? Math.min(0.98, Math.max(0.85, match.similarityScore))
            : Math.max(0.84, 0.96 - matchIdx * 0.05);

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
            similarityScore: dynamicScore,
            matchLabel: match.confidence === 'exact' ? (isBn ? 'নিখুঁত মিল' : 'Exact Visual Match') : (isBn ? 'শনাক্তকৃত মিল' : 'Detected Match'),
            matchedFeatures: match.matchedFeatures || [fullProd.category || 'Tech Gadget'],
          });
          matchIdx++;
          if (finalMatchedItems.length >= 3) break;
        }
      }
    }

    // Secondary Precise Keyword Matching (Requires Specific Product-Type Keyword, NEVER generic 'bluetooth' or 'wireless')
    if (isGadget && !isSelfieOrTripod && finalMatchedItems.length === 0 && detectedItemTitle) {
      const directCandidates = catalogProducts.filter((p) => {
        const titleLower = (p.title || p.name || '').toLowerCase();
        
        if (isMicrophone) {
          const isAudio = (p.category || '').toLowerCase() === 'audio';
          const isMic = /\b(mic|mics|microphone|microphones|lavalier|podcast|sm7b|mv7|shure|condenser)\b/i.test(titleLower);
          return isAudio && isMic;
        }
        if (isHeadphonesOrSpeakers) {
          return (titleLower.includes('headphone') || titleLower.includes('wh-1000') || titleLower.includes('quietcomfort') || titleLower.includes('airpods') || titleLower.includes('momentum') || titleLower.includes('speaker') || titleLower.includes('stanmore')) && !titleLower.includes('mic');
        }
        if (isWatchOrWearable) {
          return titleLower.includes('watch') || titleLower.includes('ultra') || titleLower.includes('fenix') || titleLower.includes('glasses');
        }
        if (isKeyboardOrMouse) {
          return titleLower.includes('keyboard') || titleLower.includes('keychron') || titleLower.includes('mx master') || titleLower.includes('mouse');
        }
        return false;
      });

      if (directCandidates.length > 0) {
        directCandidates.slice(0, 3).forEach((fullProd, idx) => {
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
            similarityScore: Math.max(0.82, 0.95 - idx * 0.06),
            matchLabel: isBn ? 'শনাক্তকৃত মিল' : 'Detected Match',
            matchedFeatures: [fullProd.category || 'Tech', fullProd.brand || 'Premium'].filter(Boolean),
          });
        });
      }
    }

    // 🌟 5. Build "You May Also Like" / "আপনারা দেখতে পারেন" Recommendations (when 1 or 2 items match)
    const recommendedItems: VisualMatchedItem[] = [];
    if (isGadget && finalMatchedItems.length > 0 && finalMatchedItems.length < 3) {
      const matchedIds = new Set(finalMatchedItems.map((item) => item.product._id));
      const remainingSlots = 3 - finalMatchedItems.length;

      // Filter catalog items that are not in matchedItems
      const unselectedCatalog = catalogProducts.filter((p) => !matchedIds.has(p._id));
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

    // 💡 6. Fetch 2-4 Alternative Products if Gadget is Out of Stock or Not in Direct Catalog (0 matches)
    let alternativeItems: VisualMatchedItem[] = [];
    if (isGadget && finalMatchedItems.length === 0) {
      let categoryProds: VisualCatalogItem[] = [];

      if (isMicrophone) {
        // Strict audio / mic alternative filtering
        categoryProds = catalogProducts.filter((p) => {
          const cat = (p.category || '').toLowerCase();
          const title = (p.title || p.name || '').toLowerCase();
          return cat === 'audio' || title.includes('mic') || title.includes('headphone') || title.includes('audio');
        });
      } else {
        categoryProds = catalogProducts.filter(
          (p) => p.category?.toLowerCase() === detectedCategory.toLowerCase()
        );
      }
      
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

    const responsePayload = {
      categoryType,
      detectedCategory,
      detectedItem: detectedItemTitle,
      isGadget,
      isCatalogAvailable: finalMatchedItems.length > 0,
      aiMessage,
      queryVisualTags: queryVisualTags.length > 0 ? queryVisualTags : ['visual-search', 'ai-vision'],
      matchedItems: finalMatchedItems,
      recommendedItems,
      alternativeItems,
    };

    // Cache the visual response ONLY if AI successfully analyzed the image
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
