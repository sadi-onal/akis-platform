/**
 * Turkish UI strings for dashboard pages.
 * Only user-visible text — code identifiers, types, API paths stay English.
 */
export const TR = {
  // Sidebar
  overview: 'Genel Bakış',
  workflows: 'İş Akışları',
  agents: 'Ajanlar',
  settings: 'Ayarlar',
  collapse: 'Daralt',
  signOut: 'Çıkış Yap',

  // Overview
  goodMorning: 'Günaydın',
  goodAfternoon: 'İyi günler',
  goodEvening: 'İyi akşamlar',
  whatsHappening: 'İş akışlarınızla ilgili son durum',
  totalWorkflows: 'Toplam İş Akışı',
  successRate: 'Başarı Oranı',
  avgDuration: 'Ort. Süre',
  testsGenerated: 'Oluşturulan Test',
  thisWeek: 'bu hafta',
  completed: 'tamamlandı',
  scribeToTrace: 'Scribe \u2192 Trace',
  acrossWorkflows: 'iş akışı genelinde',
  newWorkflow: 'Yeni İş Akışı',

  // Workflows
  manageWorkflows: 'Scribe \u2192 Proto \u2192 Trace iş akışlarınızı yönetin',
  all: 'Tümü',
  running: 'Çalışıyor',
  awaiting: 'Onay Bekliyor',
  failed: 'Başarısız',

  // Workflow Detail
  chat: 'Sohbet',
  stages: 'Aşamalar',
  files: 'Dosyalar',
  preview: 'Önizleme',

  // Chat
  scribeThinking: 'Scribe düşünüyor...',
  protoBuilding: 'Proto scaffold oluşturuyor...',
  traceWriting: 'Trace test yazıyor...',
  answerQuestions: "Scribe'ın sorularını yanıtlayın...",
  specFeedback: 'Spec hakkında geri bildirim yazın...',
  writeMessage: 'Mesajınızı yazın...',
  pipelineCompleted: 'Pipeline tamamlandı',
  specApproved: 'Spec onaylandı \u2014 Proto aşamasına geçiliyor.',
  specCreated: 'Spec oluşturuldu:',

  // Spec
  structuredSpec: 'YAPILANDIRILMIŞ SPESİFİKASYON',
  problemStatement: 'PROBLEM TANIMI',
  userStories: 'KULLANICI HİKAYELERİ',
  acceptanceCriteria: 'KABUL KRİTERLERİ',
  technicalConstraints: 'TEKNİK KISITLAMALAR',
  outOfScope: 'KAPSAM DIŞI',

  // Approve
  approveAndContinue: 'Onayla ve Devam Et',
  reject: 'Reddet',
  repoName: 'Depo Adı',
  repoVisibility: 'Görünürlük',
  public: 'Açık',
  private: 'Özel',

  // Agents
  agentsTitle: 'Ajanlar',
  agentsDesc: 'AKIS sıralı pipeline ajanları, iş akışları ve performans metrikleri.',
  operational: 'Aktif',
  lastRun: 'Son çalışma',
  avgConfidence: 'Ort. güven',
  avgFiles: 'Ort. dosya',
  avgTests: 'Ort. test',
  duration: 'Süre',
  successRateLabel: 'Başarı oranı',
  howConfidenceCalculated: 'Güven Skoru Nasıl Hesaplanır',
  workflow: 'İŞ AKIŞI',
  basedOnLast: 'Son {n} tamamlanmış iş akışına dayanır',

  // Settings
  settingsTitle: 'Ayarlar',
  settingsDesc: 'Hesabınızı ve entegrasyonlarınızı yönetin.',
  profile: 'Profil',
  github: 'GitHub',
  password: 'Şifre',

  // New Workflow
  newWorkflowTitle: 'Yeni İş Akışı',
  newWorkflowDesc: 'Fikrinizi anlatın, ajanlar sizin için geliştirsin.',
  yourIdea: 'Fikriniz',
  ideaPlaceholder: 'Proje fikrinizi sade bir dille anlatın...',
  targetRepo: 'Hedef Depo',
  cancel: 'İptal',
  startWorkflow: 'İş Akışını Başlat',
  model: 'AI Modeli',

  // Git
  cloneRepo: 'Klonla',
  viewOnGithub: "GitHub'da Görüntüle",
  createPR: 'PR Oluştur',
  copied: 'Kopyalandı!',
  cloneCommandCopied: 'Klon komutu kopyalandı!',

  // Preview
  previewLoading: 'Önizleme başlatılıyor...',
  previewFetchingFiles: 'Proto dosyaları çekiliyor',
  sandpackLoading: 'Sandpack önizleme başlatılıyor',
  previewFailed: 'Önizleme yüklenemedi',
  retry: 'Tekrar Dene',
  noFilesYet: 'Henüz dosya yok. Proto tamamlandığında preview burada görünecek.',

  // Quick Actions
  quickActions: 'HIZLI İŞLEMLER',
  describeIdea: 'Bir fikir anlat, kod al',
  checkAgents: 'Ajan durumu ve metrikleri',
  manageIntegrations: 'GitHub ve entegrasyonlar',
  viewAll: 'Tümünü gör',

  // Activity
  recentActivity: 'SON AKTİVİTE',
  recentWorkflows: 'SON İŞ AKIŞLARI',
  noWorkflows: 'Henüz iş akışı yok',
  createFirst: 'İlk iş akışınızı başlatın',
  createWorkflow: 'İş Akışı Oluştur',

  // Agent Health
  agentHealth: 'AJAN DURUMU',

  // API Usage
  apiUsage: 'API KULLANIMI \u2014 Bu Ay',
  tokensUsed: 'token kullanıldı',
  limit: 'limit',
  calls: 'çağrı',

  // Pipeline Summary
  pipelineCompleted2: 'Pipeline Tamamlandı',
  pipelineFailed: 'Pipeline Başarısız',
  pipelineStarting: 'Pipeline başlatılıyor...',
  processing: 'İşleniyor...',
  approvingLabel: 'Onaylanıyor...',
  total: 'Toplam',
  filesLabel: 'Dosya',
  linesLabel: 'Satır',
  testsLabel: 'Test',
  coverageLabel: 'Kapsam',
  confidenceLabel: 'güven',
  rejectReason: 'Neden reddediyorsunuz? (opsiyonel)',
  copiedLabel: 'Kopyalandı',
  copyError: 'Hatayı Kopyala',
  viewFiles: 'Dosyaları Gör',

  // Thinking Steps
  analyzingIdea: 'Kullanıcı fikrini analiz et',
  determinePlatform: 'Platform ve teknoloji gereksinimlerini belirle',
  generateClarifications: 'Clarification soruları oluştur',
  prepareDraft: 'Spec taslağı hazırla',
  generateSpec: 'Yapılandırılmış spec oluştur',
  calculateConfidence: 'Güven skoru hesapla',
  planFileStructure: 'Dosya yapısını planla',
  generateScaffold: 'Scaffold kodunu oluştur',
  createGithubRepo: 'GitHub deposunu oluştur',
  pushToGithub: "GitHub'a push et",
  generateReport: 'Tamamlanma raporu oluştur',
  readCodeFromGithub: "Proto kodunu GitHub'dan oku",
  analyzeEndpoints: 'Endpoint ve route\'ları analiz et',
  generateTestCases: 'Test senaryoları oluştur',
  writePlaywright: 'Playwright testleri yaz',
  coverageReport: 'Coverage raporu oluştur',

  // Post-pipeline actions
  continueDev: 'Geliştirmeye Devam Et',
  nextSteps: 'Sonraki adımlar',
  cloneCopied: 'Klon komutu kopyalandı!',
  storiesLabel: 'hikaye',
  criteriaLabel: 'kriter',
  pipelineCompletedInput: "Pipeline tamamlandı. 'Geliştirmeye Devam Et' butonunu kullanın veya yeni bir iş akışı başlatın.",

  // Confidence explanation
  confidenceExplainTitle: 'Güven Skoru Nasıl Hesaplanır',
  confidenceExplainIntro: "AKIS Scribe'ın ürettiği spec'in kalitesini dört boyutta değerlendirir:",
  completeness: 'Tamlık',
  completenessDesc: "Problem tanımı, kullanıcı hikayeleri, kabul kriterleri, teknik kısıtlamalar ve kapsam dışı bölümlerinin hepsinin doldurulup doldurulmadığını kontrol eder.",
  completenessFormula: 'C\u2081 = (dolu_bölüm_sayısı / toplam_bölüm) \u00D7 100',
  requirementClarity: 'Gereksinim Netliği',
  requirementClarityDesc: 'Kullanıcı hikayelerinin spesifik olup olmadığını, kabul kriterlerinin test edilebilir Given/When/Then formatında olup olmadığını değerlendirir.',
  scopeDefinition: 'Kapsam Tanımı',
  scopeDefinitionDesc: "Out of Scope'un net olup olmadığını, teknik kısıtlamaların belirli olup olmadığını ölçer.",
  userAlignment: 'Kullanıcı Uyumu',
  userAlignmentDesc: "Spec'in kullanıcı yanıtlarıyla ne kadar uyumlu olduğunu değerlendirir.",
  totalConfidenceFormula: 'Toplam Güven = w\u2081\u00D7C\u2081 + w\u2082\u00D7C\u2082 + w\u2083\u00D7C\u2083 + w\u2084\u00D7C\u2084',
  example: 'Örnek: 0.40\u00D795 + 0.30\u00D788 + 0.20\u00D792 + 0.10\u00D785 = 91.9%',
} as const;
