-- Data contoh awal. Aman dijalankan berulang kali.
-- Jalankan setelah migration: npm run db:setup -- --seed

insert into public.candidates (id, number, name, photo_url, vision)
values
    (
        '11111111-1111-4111-8111-111111111111',
        1,
        'Taruna Utama Alamsyah & Taruna Madya Rina',
        'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=500&auto=format&fit=crop&q=80',
        'Mewujudkan korps taruna yang berintegritas tinggi, disiplin tangguh, dan adaptif terhadap teknologi modern.'
    ),
    (
        '22222222-2222-4222-8222-222222222222',
        2,
        'Taruna Utama Bagas & Taruna Madya Maya',
        'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=500&auto=format&fit=crop&q=80',
        'Sinergi korps taruna yang inklusif, berprestasi gemilang di tingkat nasional, dan humanis.'
    )
on conflict (id) do nothing;

insert into public.candidate_missions (candidate_id, position, text)
select mission.candidate_id, mission.position, mission.text
from (
    values
        ('11111111-1111-4111-8111-111111111111'::uuid, 1, 'Peningkatan kualitas kepemimpinan & karakter taruna'),
        ('11111111-1111-4111-8111-111111111111'::uuid, 2, 'Penguatan budaya disiplin kreatif dan solidaritas angkatan'),
        ('11111111-1111-4111-8111-111111111111'::uuid, 3, 'Digitalisasi sistem informasi dan sarana belajar taruna'),
        ('22222222-2222-4222-8222-222222222222'::uuid, 1, 'Pengembangan bakat olahraga, seni, dan prestasi akademik'),
        ('22222222-2222-4222-8222-222222222222'::uuid, 2, 'Program mentoring intensif antara taruna senior dan junior'),
        ('22222222-2222-4222-8222-222222222222'::uuid, 3, 'Perluasan kegiatan bakti sosial dan pengabdian masyarakat')
) as mission(candidate_id, position, text)
where exists (select 1 from public.candidates c where c.id = mission.candidate_id)
  and not exists (select 1 from public.candidate_missions m where m.candidate_id = mission.candidate_id);

insert into public.voters (name, class_name, nit)
values
    ('TARUNA AHMAD RISKY', '1A', 'NIT2026001'),
    ('TARUNA BUDI SANTOSO', '1A', 'NIT2026002'),
    ('TARUNA CITRA DEWI', '1B', 'NIT2026003'),
    ('TARUNA DENI KURNIAWAN', '1B', 'NIT2026004'),
    ('TARUNA EKA PUTRA', '1C', 'NIT2026005')
on conflict (nit) do nothing;
