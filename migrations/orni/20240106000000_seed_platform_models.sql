-- Seed platform models (free-tier, featured, via Groq inference)

INSERT INTO users (id, wallet_address, display_name, is_creator)
VALUES ('00000000-0000-0000-0000-000000000001', NULL, 'Orni Platform', TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO models (id, creator_id, slug, name, description, system_prompt, base_model, provider_model_id, status, price_per_query, category, is_featured, is_platform_model, free_queries_per_day)
VALUES
    ('00000000-0000-0000-0000-000000000010',
     '00000000-0000-0000-0000-000000000001',
     'llama-3-8b',
     'Llama 3.1 8B',
     'Meta''s fast and capable open-source model. Great for everyday tasks, coding help, and quick answers.',
     'You are a helpful, friendly AI assistant powered by Llama 3.1 8B. Be concise and accurate.',
     'llama-3.1-8b-instant',
     'llama-3.1-8b-instant',
     'live', 50000, 'Technology',
     TRUE, TRUE, 5),

    ('00000000-0000-0000-0000-000000000011',
     '00000000-0000-0000-0000-000000000001',
     'qwen-32b',
     'Qwen3 32B',
     'Alibaba''s powerful reasoning model. Excellent at analysis, code generation, and multilingual tasks.',
     'You are a helpful AI assistant powered by Qwen3 32B. Provide clear, well-structured responses.',
     'qwen/qwen3-32b',
     'qwen/qwen3-32b',
     'live', 50000, 'Technology',
     TRUE, TRUE, 5),

    ('00000000-0000-0000-0000-000000000012',
     '00000000-0000-0000-0000-000000000001',
     'llama-3-70b',
     'Llama 3.3 70B',
     'Meta''s most capable open model. Best for complex reasoning, detailed analysis, and creative writing.',
     'You are a helpful, knowledgeable AI assistant powered by Llama 3.3 70B. Provide thorough, accurate responses.',
     'llama-3.3-70b-versatile',
     'llama-3.3-70b-versatile',
     'live', 200000, 'Technology',
     TRUE, TRUE, 3),

    ('00000000-0000-0000-0000-000000000013',
     '00000000-0000-0000-0000-000000000001',
     'llama-scout-17b',
     'Llama 4 Scout 17B',
     'Meta''s latest Llama 4 model. Fast, smart, and great for coding and reasoning tasks.',
     'You are a coding and reasoning assistant powered by Llama 4 Scout. Help users write clean, efficient code and think through problems clearly.',
     'meta-llama/llama-4-scout-17b-16e-instruct',
     'meta-llama/llama-4-scout-17b-16e-instruct',
     'live', 100000, 'Technology',
     TRUE, TRUE, 5)
ON CONFLICT DO NOTHING;
