# AKIS Pipeline Devam Senaryolari

## UC-POST-001: Pipeline Tamamlandiktan Sonra Proje Bilgisi Goruntuleme
**Aktor:** Kullanici
**On Kosul:** Pipeline completed/completed_partial
**Temel Akis:**
1. Pipeline tamamlanir
2. Chat'te otomatik bilgi karti gosterilir (repo URL, branch, dosya sayisi, test sonuclari)
3. Kullanici "GitHub'da Ac" veya "Kopyala" butonlarini kullanir
4. Chat input aktif kalir
**Son Kosul:** Kullanici projesine erisebilir, sohbete devam edebilir

## UC-POST-002: Pipeline Sonrasi Soru Sorma / Not Birakma
**Aktor:** Kullanici
**On Kosul:** Pipeline completed
**Temel Akis:**
1. Kullanici chat input'a mesaj yazar ("Bu projede auth nasil calisiyor?" veya "su hata var duzelt")
2. Mesaj chat'e eklenir ve backend'e kaydedilir
3. (MVP) Mesaj kaydedilir, chat'te gorunur. AI cevap vermez — kullanici not birakabilir.
4. (Ileri versiyon — future work) Hafif model (Haiku) ile proje context'inde cevap verir, kod modifiye eder, yeni commit atar
**Son Kosul:** Kullanici mesaji gonderebilir, mesaj kayitli kalir

## UC-CHAT-001: Pipeline Calisirken Mesaj Birakma
**Aktor:** Kullanici
**On Kosul:** Pipeline running (proto_building veya trace_testing)
**Temel Akis:**
1. Proto veya Trace calisirken kullanici chat input'a mesaj yazar
2. Mesaj kaydedilir ve chat'te gorunur
3. Pipeline durumu DEGISMEZ — agent calismaya devam eder
4. Bilgi mesaji: "Proto/Trace calisiyor, mesajiniz kaydedildi"
**Son Kosul:** Pipeline akisi bozulmaz, mesaj kayitli

## UC-CHAT-002: Her Durumda Aktif Chat Input
**Aktor:** Kullanici
**On Kosul:** Herhangi bir pipeline state'i
**Temel Akis:**
1. Chat input HER ZAMAN aktif ve yazilabilir durumda
2. Placeholder metni mevcut state'e gore degisir
3. Kullanici istedigi zaman mesaj gonderebilir
4. Mesaj ilgili state handler'ina yonlendirilir
**Son Kosul:** Input asla disabled olmaz

## UC-POST-003: Kismi Tamamlanan Pipeline'da Trace Retry
**Aktor:** Kullanici
**On Kosul:** Pipeline completed_partial (Proto basarili, Trace basarisiz)
**Temel Akis:**
1. Bilgi kartinda "Trace basarisiz — testler yazilamadi" mesaji gosterilir
2. "Trace'i Tekrar Dene" butonu gosterilir
3. Kullanici tiklar
4. Trace tekrar calisir, sonuc guncellenir
**Son Kosul:** Trace basarili olursa pipeline completed olur

## UC-POST-004: Tamamlanan Pipeline'in Detaylarini Inceleme
**Aktor:** Kullanici
**On Kosul:** Pipeline completed
**Temel Akis:**
1. Kullanici chat'teki eski mesajlari scroll eder
2. Spec kartini acar — detaylari gorur
3. Proto kartini acar — dosya listesini gorur
4. Test kartini acar — test dosyalarini gorur
5. Sag panelde Preview/Editor/Files sekmelerini kullanir
**Son Kosul:** Tum pipeline ciktilari incelenebilir

## UC-POST-005: Yeni Sohbet Baslatma (Mevcut Pipeline Bittikten Sonra)
**Aktor:** Kullanici
**On Kosul:** Mevcut pipeline completed
**Temel Akis:**
1. Kullanici sidebar'dan "Yeni Sohbet" tiklar
2. Yeni bos chat acilir
3. Kullanici yeni fikir yazar
4. Yeni pipeline baslar (yeni repo olusur)
**Son Kosul:** Eski pipeline'a sidebar'dan geri donulebilir

## UC-POST-006: Tamamlanan Pipeline'a Sidebar'dan Geri Donme
**Aktor:** Kullanici
**On Kosul:** Birden fazla pipeline/sohbet var
**Temel Akis:**
1. Kullanici sidebar'daki sohbet listesinden eski pipeline'i secer
2. Chat gecmisi yuklenir
3. Pipeline sonuc karti gorunur
4. Chat input aktif — soru sorabilir
**Son Kosul:** Eski sohbete sorunsuz donulebilir

## UC-NAVIGATE-001: Geri Tusu Davranisi
**Aktor:** Kullanici
**On Kosul:** Herhangi bir chat acik
**Temel Akis:**
1. Chat acikken geri tusuna basar
2. Chat listesine (sidebar) doner
3. Onboarding/welcome sayfasi GORUNMEMELI (ilk giris harici)
**Son Kosul:** Dogru navigasyon, welcome page'e dusmez

## UC-NAVIGATE-002: Yeni Sohbetten Geri Donme
**Aktor:** Kullanici
**On Kosul:** "Yeni Sohbet" acik, henuz mesaj yazilmadi
**Temel Akis:**
1. Geri tusuna basar
2. Chat listesine doner (sidebar)
3. Bos sohbet silinir veya kalir (kabul edilebilir her iki davranis)
**Son Kosul:** Welcome sayfasina DUSMEMELI
