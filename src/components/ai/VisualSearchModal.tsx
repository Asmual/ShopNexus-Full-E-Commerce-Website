'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  Camera,
  Upload,
  X,
  Sparkles,
  Loader2,
  ShoppingBag,
  ArrowRight,
  SwitchCamera,
  AlertCircle,
} from 'lucide-react';
import { useCartStore } from '@/store/useCartStore';
import { useLanguageStore } from '@/store/useLanguageStore';
import { toBengaliNumber } from '@/lib/translations';
import { getLocalizedCategory } from '@/lib/localizedProducts';

interface VisualSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export interface VisualMatchedResult {
  product: {
    _id: string;
    title: string;
    category?: string;
    brand?: string;
    price?: number;
    discountPrice?: number;
    images?: string[];
    image?: string;
    stock?: number;
    description?: string;
    vendorName?: string;
  };
  similarityScore: number;
  matchLabel?: string;
  confidence?: string;
  matchedFeatures?: string[];
}

export const VisualSearchModal: React.FC<VisualSearchModalProps> = ({ isOpen, onClose }) => {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanningStep, setScanningStep] = useState<string>('');
  const [results, setResults] = useState<VisualMatchedResult[]>([]);
  const [recommendedResults, setRecommendedResults] = useState<VisualMatchedResult[]>([]);
  const [alternativeResults, setAlternativeResults] = useState<VisualMatchedResult[]>([]);
  const [detectedCategory, setDetectedCategory] = useState<string>('');
  const [tags, setTags] = useState<string[]>([]);
  const [detectedTitle, setDetectedTitle] = useState<string>('');
  
  const [aiResponseData, setAiResponseData] = useState<{
    categoryType?: string;
    isGadget?: boolean;
    isCatalogAvailable?: boolean;
    aiMessage?: string;
  } | null>(null);

  // Camera capture state
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const { addItem, openDrawer } = useCartStore();
  const { language } = useLanguageStore();
  const isBn = language === 'bn';

  // Stop camera when closing or unmounting
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
    setCameraError(null);
  }, []);

  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (prevIsOpen && !isOpen) {
    setPrevIsOpen(isOpen);
    setSelectedImage(null);
    setResults([]);
    setRecommendedResults([]);
    setAlternativeResults([]);
    setDetectedCategory('');
    setTags([]);
    setAiResponseData(null);
    setIsScanning(false);
  } else if (!prevIsOpen && isOpen) {
    setPrevIsOpen(isOpen);
  }

  useEffect(() => {
    if (!isOpen && streamRef.current) {
      stopCamera();
    }
  }, [isOpen, stopCamera]);

  // Start Camera Stream
  const startCamera = async (mode: 'user' | 'environment' = facingMode) => {
    stopCamera();
    setIsCameraActive(true);
    setCameraError(null);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(isBn ? 'আপনার ব্রাউজার ক্যামেরা অ্যাক্সেস সমর্থন করে না।' : 'Camera access is not supported on this browser.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err: unknown) {
      console.error('Camera access error:', err);
      setCameraError(
        isBn
          ? 'ক্যামেরা চালু করতে সমস্যা হয়েছে। অনুগ্রহ করে ব্রাউজার পারমিশন চেক করুন অথবা ফাইল আপলোড করুন।'
          : 'Could not access device camera. Please check camera permissions or upload an image file instead.'
      );
      setIsCameraActive(false);
    }
  };

  const toggleCameraFacing = () => {
    const nextMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(nextMode);
    startCamera(nextMode);
  };

// Client-side instant Canvas compression (drastically accelerates network transfer and AI processing to ~1s)
const compressImageForVision = (source: File | string, maxDimension = 512, quality = 0.75): Promise<string> => {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve(typeof source === 'string' ? source : '');
      return;
    }
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } else {
        resolve(typeof source === 'string' ? source : '');
      }
    };
    img.onerror = () => {
      resolve(typeof source === 'string' ? source : '');
    };
    if (typeof source === 'string') {
      img.src = source;
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        img.src = (e.target?.result as string) || '';
      };
      reader.readAsDataURL(source);
    }
  });
};

  const handleCapturePhoto = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const maxDim = 512;
    let w = video.videoWidth || 640;
    let h = video.videoHeight || 480;
    if (w > maxDim || h > maxDim) {
      if (w > h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }
    const canvas = canvasRef.current || document.createElement('canvas');
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, w, h);
      const base64 = canvas.toDataURL('image/jpeg', 0.75);
      stopCamera();
      setSelectedImage(base64);
      runVisualSearch(base64);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const compressed = await compressImageForVision(file, 512, 0.75);
      setSelectedImage(compressed);
      runVisualSearch(compressed);
    } catch {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64 = event.target?.result as string;
        setSelectedImage(base64);
        runVisualSearch(base64);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSampleImage = (url: string) => {
    setSelectedImage(url);
    runVisualSearch(url);
  };

  const runVisualSearch = async (imageInput: string) => {
    setIsScanning(true);
    setResults([]);
    setRecommendedResults([]);
    setAlternativeResults([]);
    setDetectedCategory('');
    setTags([]);
    setDetectedTitle('');
    setAiResponseData(null);
    setScanningStep(isBn ? 'Gemini Vision AI ছবি বিশ্লেষণ করছে...' : 'Analyzing with Gemini Vision AI...');

    const stepTimer = setTimeout(() => {
      setScanningStep(isBn ? 'ক্যাটালগে ভেক্টর সিমিলারিটি মেলানো হচ্ছে...' : 'Matching vector similarities in catalog...');
    }, 1200);

    try {
      const res = await fetch('/api/ai/visual-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: imageInput.startsWith('http') ? imageInput : undefined,
          imageBase64: imageInput.startsWith('data:') ? imageInput : undefined,
          language: language,
        }),
      });

      const data = await res.json();
      if (data.success && data.data) {
        setResults(data.data.matchedItems || []);
        setRecommendedResults(data.data.recommendedItems || []);
        setAlternativeResults(data.data.alternativeItems || []);
        setDetectedCategory(data.data.detectedCategory || '');
        setTags(data.data.queryVisualTags || []);
        setDetectedTitle(data.data.detectedItem || '');
        setAiResponseData({
          categoryType: data.data.categoryType,
          isGadget: data.data.isGadget,
          isCatalogAvailable: data.data.isCatalogAvailable,
          aiMessage: data.data.aiMessage,
        });
      } else {
        throw new Error(data.message || 'Visual search failed');
      }
    } catch {
      // Graceful fallback
      setDetectedTitle(isBn ? 'ছবিটি বিশ্লেষণ করা হয়েছে' : 'Image Analyzed');
      setAiResponseData({
        isGadget: false,
        isCatalogAvailable: false,
        aiMessage: isBn
          ? 'সার্ভার সংযোগে সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।'
          : 'Failed to complete vision analysis. Please try again.',
      });
    } finally {
      clearTimeout(stepTimer);
      setIsScanning(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in-50 duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          stopCamera();
          onClose();
        }
      }}
    >
      <div className="relative w-full max-w-lg sm:max-w-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl sm:rounded-3xl p-3.5 sm:p-5 shadow-2xl overflow-hidden max-h-[88vh] flex flex-col">
        {/* Hidden Canvas for capturing camera snapshot */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800/80">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-orange-500/20 to-amber-500/20 border border-orange-500/30 flex items-center justify-center text-orange-600 dark:text-orange-400 shadow-xs shrink-0">
              <Camera className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                  {isBn ? 'এআই ভিজ্যুয়াল প্রোডাক্ট সার্চ' : 'AI Visual Product Search'}
                </h2>
                <span className="text-[9px] px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20 font-mono font-bold tracking-tight shrink-0">
                  Gemini Vision
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                {isBn
                  ? 'ছবি আপলোড করুন অথবা ক্যামেরা দিয়ে লাইভ ছবি তুলে পণ্য খুঁজুন'
                  : 'Snap a photo or upload an image to find matching catalog gear'}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="p-1.5 sm:p-2 rounded-xl text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 transition-colors cursor-pointer shrink-0 ml-2"
            title={isBn ? 'বন্ধ করুন (Esc)' : 'Close'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Error Notification */}
        {cameraError && (
          <div className="mt-2.5 p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="text-[11px] leading-tight">{cameraError}</span>
          </div>
        )}

        {/* Main Content Area (Scrollable) */}
        <div className="flex-1 overflow-y-auto my-3 space-y-3 pr-0.5">
          {/* 📷 LIVE CAMERA VIEWFINDER MODE */}
          {isCameraActive ? (
            <div className="relative rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 flex flex-col items-center justify-center aspect-video sm:aspect-[4/3] max-h-[340px] shadow-inner">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
              />

              {/* Viewfinder Target Grid Overlay */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-40 h-40 sm:w-52 sm:h-52 border-2 border-dashed border-orange-500/70 rounded-2xl animate-pulse shadow-lg shadow-orange-500/20" />
              </div>

              {/* Camera Control Overlay Buttons */}
              <div className="absolute bottom-3 inset-x-3 flex items-center justify-between gap-2 px-1">
                <button
                  type="button"
                  onClick={stopCamera}
                  className="px-3 py-1.5 rounded-xl bg-slate-900/80 backdrop-blur-md hover:bg-slate-900 text-white text-xs font-bold border border-slate-700 transition-all cursor-pointer"
                >
                  {isBn ? 'বাতিল' : 'Cancel'}
                </button>

                {/* Shutter Snap Button */}
                <button
                  type="button"
                  onClick={handleCapturePhoto}
                  className="flex items-center gap-1.5 px-4 sm:px-5 py-2 sm:py-2.5 rounded-full bg-gradient-to-r from-[#ff4400] to-[#ff7700] hover:from-[#ff5500] hover:to-[#ff8800] text-white text-xs font-black shadow-xl shadow-orange-500/40 hover:scale-105 active:scale-95 transition-all cursor-pointer"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>{isBn ? 'ছবি তুলুন ও খুঁজুন' : 'Snap & Search'}</span>
                </button>

                {/* Switch Camera Button (Front / Back) */}
                <button
                  type="button"
                  onClick={toggleCameraFacing}
                  className="p-2 rounded-xl bg-slate-900/80 backdrop-blur-md hover:bg-slate-900 text-white border border-slate-700 transition-all cursor-pointer"
                  title={isBn ? 'ক্যামেরা পরিবর্তন করুন' : 'Switch Camera'}
                >
                  <SwitchCamera className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : !selectedImage ? (
            /* 📤 INITIAL UPLOAD / SNAP CHOOSER */
            <div className="space-y-3">
              {/* Option 1: Live Camera Button */}
              <button
                type="button"
                onClick={() => startCamera('environment')}
                className="w-full p-3 sm:p-3.5 rounded-2xl bg-gradient-to-r from-orange-500/10 via-amber-500/10 to-orange-500/5 hover:from-orange-500/20 hover:to-amber-500/20 border border-orange-500/30 text-slate-900 dark:text-white flex items-center justify-between gap-3 transition-all cursor-pointer group shadow-xs hover:scale-[1.01]"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-orange-500 text-white flex items-center justify-center shadow-md shadow-orange-500/30 group-hover:scale-105 transition-transform shrink-0">
                    <Camera className="w-5 h-5" />
                  </div>
                  <div className="text-left min-w-0">
                    <h3 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white truncate">
                      {isBn ? 'লাইভ ক্যামেরা দিয়ে ছবি তুলুন' : 'Take a Live Photo'}
                    </h3>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {isBn ? 'ডিভাইসের ক্যামেরা দিয়ে লাইভ ক্যাপচার করুন' : 'Use smartphone or webcam to snap gear'}
                    </p>
                  </div>
                </div>
                <div className="px-3 py-1.5 rounded-xl bg-orange-500 text-white text-xs font-bold shrink-0 shadow-xs">
                  {isBn ? 'ক্যামেরা চালু করুন' : 'Open Camera'}
                </div>
              </button>

              {/* Option 2: File Dropzone */}
              <label className="flex flex-col items-center justify-center w-full h-24 sm:h-28 rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-800 hover:border-orange-500/60 bg-slate-50 dark:bg-slate-900/40 hover:bg-slate-100 dark:hover:bg-slate-900/80 cursor-pointer transition-all">
                <div className="flex flex-col items-center justify-center py-2">
                  <Upload className="w-5 h-5 sm:w-6 sm:h-6 text-orange-500 mb-1 animate-bounce" />
                  <p className="text-xs font-bold text-slate-900 dark:text-white">
                    {isBn ? 'ছবি ড্রপ করুন অথবা ফাইল সিলেক্ট করুন' : 'Drag & drop or browse device photo'}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-0.5">PNG, JPG, WEBP (Max 10MB)</p>
                </div>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageUpload}
                  className="hidden"
                />
              </label>

              {/* Option 3: Sample Photos (Responsive Horizontal Scroll Pill Row) */}
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80">
                <p className="text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-2">
                  {isBn ? 'অথবা স্যাম্পল ছবি দিয়ে টেস্ট করুন:' : 'Or try testing with a sample photo:'}
                </p>
                <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:grid sm:grid-cols-3">
                  {[
                    { label: isBn ? 'মেকানিক্যাল কিবোর্ড' : 'Mechanical Keyboard', url: 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=400' },
                    { label: isBn ? 'এএনসি হেডফোন' : 'ANC Headphones', url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400' },
                    { label: isBn ? 'গেমিং মাউস' : 'Gaming Mouse', url: 'https://images.unsplash.com/photo-1615663245857-ac93bb7c39e7?w=400' },
                  ].map((sample, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSampleImage(sample.url)}
                      className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-orange-500/50 text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-all cursor-pointer shadow-xs group shrink-0 min-w-max sm:min-w-0"
                    >
                      <div className="relative w-8 h-8 rounded-lg overflow-hidden shrink-0 border border-slate-200 dark:border-slate-800">
                        <Image src={sample.url} alt={sample.label} fill className="object-cover group-hover:scale-110 transition-transform" unoptimized />
                      </div>
                      <span className="font-semibold text-xs whitespace-nowrap sm:truncate text-left">{sample.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* 🔍 RESULT & SCANNING VIEW */
            <div className="space-y-4">
              {/* Selected Image with Scanning Indicator */}
              <div className="flex items-center gap-4 p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="relative w-20 h-20 rounded-2xl overflow-hidden border border-orange-500/40 shrink-0 bg-slate-950">
                  <Image src={selectedImage} alt="Query Image" fill className="object-cover" unoptimized />
                  {isScanning && (
                    <div className="absolute inset-0 bg-orange-600/40 backdrop-blur-xs flex items-center justify-center">
                      <Loader2 className="w-7 h-7 text-white animate-spin" />
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-orange-500 shrink-0" />
                    <span>{isScanning ? scanningStep : (detectedTitle || (isBn ? 'ভিজ্যুয়াল ম্যাচ সম্পন্ন' : 'Visual Match Complete'))}</span>
                  </p>
                  
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {tags.map((t, idx) => (
                        <span
                          key={idx}
                          className="text-[10px] px-2.5 py-0.5 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20 font-mono font-semibold"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedImage(null)}
                  className="px-3 py-1.5 rounded-xl bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold cursor-pointer shrink-0 transition-colors"
                >
                  {isBn ? 'অন্য ছবি' : 'Change'}
                </button>
              </div>

              {/* Results List / Contextual AI Feedback */}
              <div className="space-y-3 max-h-[340px] overflow-y-auto pr-1">
                {isScanning ? (
                  <div className="py-8 flex flex-col items-center justify-center gap-3 text-slate-400">
                    <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
                    <p className="text-xs font-bold text-slate-500 dark:text-slate-400 animate-pulse">
                      {isBn ? 'Gemini Vision AI ছবি ও ডাটাবেজ ক্যাটালগ যাচাই করছে...' : 'Gemini Vision AI is analyzing image with live catalog...'}
                    </p>
                  </div>
                ) : aiResponseData && !aiResponseData.isGadget ? (
                  /* 👤 CASE 1: Non-Gadget / Selfie / Human / Scenery Detected */
                  <div className="p-3 sm:p-4 rounded-2xl bg-sky-500/10 dark:bg-sky-500/15 border border-sky-500/30 text-slate-900 dark:text-white space-y-2.5 shadow-xs">
                    <div className="flex items-start gap-2.5">
                      <div className="w-8 h-8 rounded-xl bg-sky-500/20 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                        <AlertCircle className="w-4 h-4" />
                      </div>
                      <div className="space-y-0.5 min-w-0">
                        <h4 className="text-[11px] sm:text-xs font-black uppercase tracking-wider text-sky-700 dark:text-sky-300">
                          {isBn ? 'নন-গ্যাজেট ছবি শনাক্তকৃত' : 'NON-GADGET IMAGE DETECTED'}
                        </h4>
                        <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                          {aiResponseData.aiMessage ||
                            (isBn
                              ? `শনাক্তকৃত বিষয়: "${detectedTitle}"। এটি কোনো ইলেকট্রনিক্স গ্যাজেট বা শপের পণ্য নয়। ShopNexus শুধুমাত্র প্রিমিয়াম মেকানিক্যাল কিবোর্ড, হেডফোন, স্মার্টওয়াচ ও অডিও গিয়ার বিক্রয় করে।`
                              : `Detected: "${detectedTitle}". This is not an electronic gadget. ShopNexus exclusively sells premium tech gear, mechanical keyboards, headphones & smart accessories.`)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-sky-500/20">
                      <span className="text-[10px] sm:text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                        {isBn ? 'গ্যাজেটের ছবি দিয়ে খুঁজুন:' : 'Try photographing a gadget:'}
                      </span>
                      <button
                        type="button"
                        onClick={() => startCamera('environment')}
                        className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-[#ff4400] to-[#ff7700] text-white text-xs font-bold hover:scale-105 active:scale-95 transition-all cursor-pointer shadow-xs"
                      >
                        {isBn ? 'ক্যামেরা খুলুন' : 'Open Camera'}
                      </button>
                    </div>
                  </div>
                ) : aiResponseData && aiResponseData.isGadget && (!aiResponseData.isCatalogAvailable || results.length === 0) ? (
                  /* ⚠️ CASE 2: Gadget Detected but Out of Stock / Not in Catalog -> Show In-Stock Alternatives */
                  <div className="space-y-3">
                    {/* Notice Box */}
                    <div className="p-3 sm:p-4 rounded-2xl bg-amber-500/10 dark:bg-amber-500/15 border border-amber-500/30 text-slate-900 dark:text-white space-y-2.5 shadow-xs">
                      <div className="flex items-start gap-2.5">
                        <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                          <AlertCircle className="w-4 h-4" />
                        </div>
                        <div className="space-y-0.5 min-w-0">
                          <h4 className="text-[11px] sm:text-xs font-black uppercase tracking-wider text-amber-700 dark:text-amber-300">
                            {isBn ? 'গ্যাজেট শনাক্তকৃত (ওয়েবসাইটে পণ্যটি বর্তমানে নেই)' : 'GADGET DETECTED (CURRENTLY NOT IN STOCK)'}
                          </h4>
                          <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                            {aiResponseData.aiMessage ||
                              (isBn
                                ? `শনাক্তকৃত গ্যাজেট: "${detectedTitle}"। আমাদের ওয়েবসাইটে এই পণ্যটি বর্তমানে উপলব্ধ নেই। তবে আমাদের স্টকে থাকা সমজাতীয় বিকল্প পণ্য নিচে দেওয়া হলো:`
                                : `Detected Gear: "${detectedTitle}". This product is currently not available on our website. Here are top in-stock alternatives below:`)}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* In-Stock Top Store Alternatives Grid */}
                    {alternativeResults.length > 0 && (
                      <div className="space-y-2.5 pt-1">
                        <div className="flex items-center justify-between px-1">
                          <h5 className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                            <span>
                              {isBn
                                ? `${detectedCategory ? `${getLocalizedCategory(detectedCategory, language)} ক্যাটাগরিতে` : ''} আমাদের স্টকে থাকা সেরা বিকল্পসমূহ:`
                                : `Top in-stock alternatives in ${detectedCategory || 'Catalog'}:`}
                            </span>
                          </h5>
                          <span className="text-[10px] text-slate-400 font-mono">
                            {isBn ? `${toBengaliNumber(alternativeResults.length)}টি বিকল্প উপলব্ধ` : `${alternativeResults.length} Alternatives`}
                          </span>
                        </div>

                        <div className="space-y-2">
                          {alternativeResults.map((alt, idx) => {
                            const prod = alt.product;
                            const effectivePrice = prod.discountPrice || prod.price || 0;
                            const originalPrice = prod.price ?? 0;
                            return (
                              <div
                                key={idx}
                                className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800/80 hover:border-amber-500/50 flex items-center justify-between gap-3 transition-all shadow-xs group"
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <div className="relative w-12 h-12 rounded-xl overflow-hidden bg-white dark:bg-slate-950 shrink-0 border border-slate-200 dark:border-slate-800">
                                    <Image
                                      src={prod.images?.[0] || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=200'}
                                      alt={prod.title}
                                      fill
                                      className="object-cover group-hover:scale-105 transition-transform"
                                      unoptimized
                                    />
                                  </div>

                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[9px] font-black px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                        {isBn ? 'বিকল্প পছন্দ' : 'Alternative Pick'}
                                      </span>
                                      <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 truncate">
                                        {prod.category}
                                      </span>
                                    </div>

                                    <h4 className="text-xs font-bold text-slate-900 dark:text-white truncate max-w-[200px] sm:max-w-[300px] mt-0.5">
                                      {prod.title}
                                    </h4>

                                    <div className="flex items-center gap-2 mt-0.5">
                                      <span className="text-xs font-black text-orange-600 dark:text-orange-400">
                                        {isBn ? `৳${toBengaliNumber(effectivePrice.toLocaleString('en-US'))}` : `৳${effectivePrice.toLocaleString()}`}
                                      </span>
                                      {Boolean(prod.discountPrice && originalPrice > prod.discountPrice) && (
                                        <span className="text-[10px] text-slate-400 line-through">
                                          {isBn ? `৳${toBengaliNumber(originalPrice.toLocaleString('en-US'))}` : `৳${originalPrice.toLocaleString()}`}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* Actions: Add to Cart & View Product */}
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      addItem({
                                        productId: prod._id,
                                        title: prod.title,
                                        price: effectivePrice,
                                        image: prod.images?.[0] || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=200',
                                        quantity: 1,
                                        stock: prod.stock || 20,
                                        vendorName: prod.vendorName || 'ShopNexus Official',
                                      });
                                      onClose();
                                      openDrawer();
                                    }}
                                    className="p-2.5 rounded-xl bg-gradient-to-r from-[#ff4400] to-[#ff7700] hover:from-[#ff5500] hover:to-[#ff8800] text-white transition-all cursor-pointer shadow-md shadow-orange-500/25 hover:scale-105 active:scale-95"
                                    title={isBn ? 'কার্টে যুক্ত করুন' : 'Add to Cart'}
                                  >
                                    <ShoppingBag className="w-4 h-4" />
                                  </button>

                                  <Link
                                    href={`/products/${prod._id}`}
                                    onClick={onClose}
                                    className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer border border-slate-200 dark:border-slate-700"
                                    title={isBn ? 'বিস্তারিত দেখুন' : 'View Details'}
                                  >
                                    <ArrowRight className="w-4 h-4" />
                                  </Link>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* See More in Category Filter Button */}
                        <div className="pt-2">
                          <Link
                            href={detectedCategory ? `/products?category=${encodeURIComponent(detectedCategory)}` : '/products'}
                            onClick={onClose}
                            className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-orange-500/10 via-amber-500/10 to-orange-500/10 hover:from-orange-500/20 hover:to-amber-500/20 border border-orange-500/30 text-orange-600 dark:text-orange-400 font-bold text-xs flex items-center justify-center gap-2 transition-all group shadow-sm hover:scale-[1.01]"
                          >
                            <span>
                              {isBn
                                ? `${detectedCategory ? `${getLocalizedCategory(detectedCategory, language)} ক্যাটাগরির` : ''} আরও সব পণ্য দেখুন (See More)`
                                : `See More ${detectedCategory ? `${detectedCategory} ` : ''}Products`}
                            </span>
                            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
                          </Link>
                        </div>
                      </div>
                    )}
                  </div>
                ) : results.length === 0 ? (
                  /* 🔍 CASE 3: No Match Fallback */
                  <div className="py-8 text-center text-slate-400 space-y-2">
                    <p className="text-xs font-bold text-slate-500">
                      {isBn ? 'কোনো সরাসরি মিল পাওয়া যায়নি।' : 'No direct visual match found in current inventory.'}
                    </p>
                    <button
                      type="button"
                      onClick={() => setSelectedImage(null)}
                      className="text-xs font-bold text-orange-600 dark:text-orange-400 underline cursor-pointer"
                    >
                      {isBn ? 'অন্য কোনো ছবি দিয়ে চেষ্টা করুন' : 'Try another photo'}
                    </button>
                  </div>
                ) : (
                  /* ✅ CASE 4: In-Catalog Matches Found (1-3 items) + Recommendations for remaining */
                  <div className="space-y-3">
                    {/* Visual Matches List */}
                    <div className="space-y-2">
                      {results.map((match, idx) => {
                        const prod = match.product;
                        const scorePercent = Math.round(match.similarityScore * 100);
                        const effectivePrice = prod.discountPrice || prod.price || 0;
                        const originalPrice = prod.price ?? 0;

                        return (
                          <div
                            key={idx}
                            className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800/80 hover:border-orange-500/50 flex items-center justify-between gap-3 transition-all shadow-xs group"
                          >
                            <div className="flex items-center gap-3.5 min-w-0">
                              <div className="relative w-14 h-14 rounded-2xl overflow-hidden bg-white dark:bg-slate-950 shrink-0 border border-slate-200 dark:border-slate-800">
                                <Image
                                  src={prod.images?.[0] || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=200'}
                                  alt={prod.title}
                                  fill
                                  className="object-cover group-hover:scale-105 transition-transform"
                                  unoptimized
                                />
                              </div>

                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                    {isBn ? `${toBengaliNumber(scorePercent)}% মিল` : `${scorePercent}% Match`}
                                  </span>
                                  <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 truncate">
                                    {prod.category}
                                  </span>
                                </div>

                                <h4 className="text-xs font-bold text-slate-900 dark:text-white truncate max-w-[260px] sm:max-w-[340px] mt-1">
                                  {prod.title}
                                </h4>

                                {/* BDT Currency Price */}
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-xs font-black text-orange-600 dark:text-orange-400">
                                    {isBn ? `৳${toBengaliNumber(effectivePrice.toLocaleString('en-US'))}` : `৳${effectivePrice.toLocaleString()}`}
                                  </span>
                                  {Boolean(prod.discountPrice && originalPrice > prod.discountPrice) && (
                                    <span className="text-[10px] text-slate-400 line-through">
                                      {isBn ? `৳${toBengaliNumber(originalPrice.toLocaleString('en-US'))}` : `৳${originalPrice.toLocaleString()}`}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Actions: Add to Cart & View Product */}
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  addItem({
                                    productId: prod._id,
                                    title: prod.title,
                                    price: effectivePrice,
                                    image: prod.images?.[0] || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=200',
                                    quantity: 1,
                                    stock: prod.stock || 20,
                                    vendorName: 'ShopNexus Official',
                                  });
                                  onClose();
                                  openDrawer();
                                }}
                                className="p-2.5 rounded-xl bg-gradient-to-r from-[#ff4400] to-[#ff7700] hover:from-[#ff5500] hover:to-[#ff8800] text-white transition-all cursor-pointer shadow-md shadow-orange-500/25 hover:scale-105 active:scale-95"
                                title={isBn ? 'কার্টে যুক্ত করুন' : 'Add to Cart'}
                              >
                                <ShoppingBag className="w-4 h-4" />
                              </button>

                              <Link
                                href={`/products/${prod._id}`}
                                onClick={onClose}
                                className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer border border-slate-200 dark:border-slate-700"
                                title={isBn ? 'বিস্তারিত দেখুন' : 'View Details'}
                              >
                                <ArrowRight className="w-4 h-4" />
                              </Link>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* ✨ 'আপনারা দেখতে পারেন' / 'You May Also Like' Recommendations (when 1 or 2 items matched) */}
                    {recommendedResults.length > 0 && (
                      <div className="pt-2 space-y-2">
                        <div className="flex items-center gap-2 px-1 pt-2 border-t border-slate-200 dark:border-slate-800">
                          <Sparkles className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                          <h5 className="text-xs font-bold text-slate-800 dark:text-slate-200">
                            {isBn ? '✨ আপনারা দেখতে পারেন' : '✨ You May Also Like'}
                          </h5>
                        </div>

                        <div className="space-y-2">
                          {recommendedResults.map((rec, recIdx) => {
                            const prod = rec.product;
                            const effectivePrice = prod.discountPrice || prod.price || 0;
                            const originalPrice = prod.price ?? 0;

                            return (
                              <div
                                key={recIdx}
                                className="p-3.5 rounded-2xl bg-slate-50/80 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 hover:border-orange-500/40 flex items-center justify-between gap-3 transition-all shadow-xs group"
                              >
                                <div className="flex items-center gap-3.5 min-w-0">
                                  <div className="relative w-14 h-14 rounded-2xl overflow-hidden bg-white dark:bg-slate-950 shrink-0 border border-slate-200 dark:border-slate-800">
                                    <Image
                                      src={prod.images?.[0] || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=200'}
                                      alt={prod.title}
                                      fill
                                      className="object-cover group-hover:scale-105 transition-transform"
                                      unoptimized
                                    />
                                  </div>

                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20">
                                        {isBn ? 'জনপ্রিয় পছন্দ' : 'Popular Pick'}
                                      </span>
                                      <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 truncate">
                                        {prod.category}
                                      </span>
                                    </div>

                                    <h4 className="text-xs font-bold text-slate-900 dark:text-white truncate max-w-[260px] sm:max-w-[340px] mt-1">
                                      {prod.title}
                                    </h4>

                                    <div className="flex items-center gap-2 mt-0.5">
                                      <span className="text-xs font-black text-orange-600 dark:text-orange-400">
                                        {isBn ? `৳${toBengaliNumber(effectivePrice.toLocaleString('en-US'))}` : `৳${effectivePrice.toLocaleString()}`}
                                      </span>
                                      {Boolean(prod.discountPrice && originalPrice > prod.discountPrice) && (
                                        <span className="text-[10px] text-slate-400 line-through">
                                          {isBn ? `৳${toBengaliNumber(originalPrice.toLocaleString('en-US'))}` : `৳${originalPrice.toLocaleString()}`}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* Actions: Add to Cart & View Product */}
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      addItem({
                                        productId: prod._id,
                                        title: prod.title,
                                        price: effectivePrice,
                                        image: prod.images?.[0] || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=200',
                                        quantity: 1,
                                        stock: prod.stock || 20,
                                        vendorName: prod.vendorName || 'ShopNexus Official',
                                      });
                                      onClose();
                                      openDrawer();
                                    }}
                                    className="p-2.5 rounded-xl bg-gradient-to-r from-[#ff4400] to-[#ff7700] hover:from-[#ff5500] hover:to-[#ff8800] text-white transition-all cursor-pointer shadow-md shadow-orange-500/25 hover:scale-105 active:scale-95"
                                    title={isBn ? 'কার্টে যুক্ত করুন' : 'Add to Cart'}
                                  >
                                    <ShoppingBag className="w-4 h-4" />
                                  </button>

                                  <Link
                                    href={`/products/${prod._id}`}
                                    onClick={onClose}
                                    className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer border border-slate-200 dark:border-slate-700"
                                    title={isBn ? 'বিস্তারিত দেখুন' : 'View Details'}
                                  >
                                    <ArrowRight className="w-4 h-4" />
                                  </Link>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VisualSearchModal;
