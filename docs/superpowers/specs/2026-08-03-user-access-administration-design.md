# Správa uživatelů, rolí a přihlášení — návrh

Datum: 3. srpna 2026  
Projekt: Sokol spolurozhoduje  
Stav: schválený návrh před realizačním plánem

## 1. Cíl a rozsah

Pilot doplní správu uživatelů a pevně vymezená oprávnění pro tři role: superadministrátor, administrátor a člen. Veřejnost bude nadále moci číst seznam norem i jejich detail bez přihlášení. Každá aktivní účast — komentář, návrh změny nebo hlas — bude svázána s ověřeným e-mailem přihlášeného člena.

Součástí této etapy je:

- samoregistrace a bezheslové přihlášení členů jednorázovým e-mailovým kódem,
- přihlášení administrátorů a superadministrátorů e-mailem a heslem,
- správa administrátorských účtů superadministrátorem,
- pevná oprávnění podle role bez individuálních výjimek,
- omezení administrátora na normy, které sám založil,
- přehledná administrace uživatelů ve variantě „tabulka + filtry + detail“,
- simulované doručování ověřovacích kódů a obnovovacích odkazů pro demoverzi,
- audit významných administrativních a přístupových událostí.

Mimo rozsah této etapy je skutečné odesílání e-mailů, napojení na členskou databázi Sokol.cz, serverová databáze a produkčně bezpečná autentizace. Členské ID se eviduje, ale automaticky se neověřuje.

## 2. Role a oprávnění

Oprávnění vycházejí výhradně z role. Aplikace nepodporuje individuální výjimky.

| Činnost | Veřejnost | Člen | Administrátor | Superadministrátor |
|---|---:|---:|---:|---:|
| Zobrazit seznam a detail publikovaných norem | ano | ano | ano | ano |
| Registrovat vlastní členský účet | — | ano | — | — |
| Komentovat, podávat návrhy a hlasovat | ne | ano, po ověření e-mailu | ano, po ověření e-mailu | ano, po ověření e-mailu |
| Zobrazit vlastní příspěvky | ne | ano | ano | ano |
| Založit normu a nahrát soubory | ne | ne | ano | ano |
| Spravovat vlastní normu | ne | ne | ano | ano |
| Spravovat normu jiného administrátora | ne | ne | ne | ano |
| Otevřít či ukončit sběr připomínek | ne | ne | vlastní norma | každá norma |
| Vypořádat a komentovat připomínku | ne | ne | vlastní norma | každá norma |
| Změnit stav nebo uzavřít proces | ne | ne | vlastní norma | každá norma |
| Založit administrátora | ne | ne | ne | ano |
| Měnit roli nebo stav uživatele | ne | ne | ne | ano |
| Zobrazit audit správy uživatelů | ne | ne | ne | ano |

Vyšší role obsahuje také oprávnění běžného člena. Správce tedy může pod stejným účtem připomínkovat a hlasovat; audit vždy rozliší účastnickou akci od správcovského zásahu. Také u správce musí být e-mail ověřený — za ověření se považuje úspěšné použití odkazu pro nastavení prvního hesla.

## 3. Přihlašování a registrace

### 3.1 Člen: registrace bez hesla

Registrace má dva kroky:

1. Člen vyplní jméno, příjmení, sokolskou jednotu, členské ID a e-mail. E-mail musí být v rámci pilotu jedinečný; členské ID je povinné, ale neověřuje se vůči externímu systému.
2. Aplikace vytvoří jednorázový šestimístný kód, zobrazí jej v simulované e-mailové schránce a vyžádá jeho zadání. Platný kód nastaví účet do stavu `active` a označí e-mail jako ověřený.

Kód platí 10 minut, lze jej použít pouze jednou a je povoleno nejvýše pět chybných pokusů. Po vypršení nebo vyčerpání pokusů musí člen požádat o nový kód.

### 3.2 Člen: další přihlášení

Člen zadá pouze e-mail. Existujícímu aktivnímu členskému účtu se vytvoří nový jednorázový kód se stejnými pravidly jako při registraci. Neznámý e-mail nabídne přechod k registraci. Člen nemá heslo ani obnovu hesla.

### 3.3 Administrátor a superadministrátor: přihlášení heslem

Správci se přihlašují e-mailem a nastavitelným heslem. Formulář podle nalezeného účtu zvolí správnou metodu: členu nabídne kód, správci heslo. Chybná kombinace e-mailu a hesla nesmí prozradit, která část údaje je nesprávná.

Administrátorský účet vytváří pouze superadministrátor. Nový správce dostane do simulované schránky jednorázový odkaz pro nastavení prvního hesla. Odkaz platí 30 minut a po použití se zneplatní. Heslo musí mít alespoň 10 znaků a obsahovat malé písmeno, velké písmeno, číslici a speciální znak.

Správce může heslo změnit po přihlášení. Při zapomenutí hesla zadá e-mail a obdrží do simulované schránky jednorázový odkaz pro nastavení nového hesla. Rozhraní vždy zobrazí neutrální potvrzení, aby neprozrazovalo existenci účtu.

V klientské demoverzi se heslo nesmí ukládat jako čitelný text. `AuthService` z něj pomocí Web Crypto odvodí hash se samostatnou solí. Jde pouze o realistickou simulaci; protože aplikace nemá důvěryhodný server, nelze tento mechanismus považovat za produkční zabezpečení.

### 3.4 Relace a blokace

Úspěšné přihlášení vytvoří relaci platnou osm hodin, která přežije obnovení stránky. Odhlášení relaci okamžitě zruší. Zablokování účtu ukončí jeho aktivní relaci. Změna role se projeví okamžitě a při následující autorizované akci se vyhodnotí znovu.

## 4. Modelové účty demoverze

Demoverze se inicializuje následujícími účty:

| Role | E-mail | Přihlášení |
|---|---|---|
| Superadministrátor | `superadmin@sokol.demo` | heslo `SuperSokol!2026` |
| Administrátor | `administrator@sokol.demo` | heslo `AdminSokol!2026` |
| Člen | `clen@sokol.demo` | jednorázový kód `260814` |

Modelová hesla a kód jsou veřejné testovací údaje a rozhraní je zobrazí v panelu „Vyzkoušet demoverzi“. Nesmějí se použít v produkčním prostředí. Nově registrovaným členům se generuje náhodný šestimístný demo kód; správci dostávají náhodné jednorázové tokeny pro nastavení nebo obnovu hesla.

## 5. Uživatelské rozhraní

### 5.1 Veřejná část

Landing page nadále obsahuje seznam číslovaných norem, jejich stav a základní metadata. Detail normy, důvodová zpráva, soubory a dosavadní transparentní průběh jsou veřejné bez přihlášení. Pokus o komentář, návrh nebo hlasování otevře přihlašovací dialog s vysvětlením, že aktivní účast vyžaduje ověřený e-mail.

Do datového modelu se již nyní přidá `visibilityMode` s výchozí hodnotou `public-detail`. Budoucí režim `title-only` umožní ponechat veřejný pouze název normy a detail zobrazit až přihlášenému uživateli, ale v této etapě nebude možné režim v rozhraní přepnout.

### 5.2 Členská část

Po přihlášení člen vidí profil se svými registračními údaji a přehled vlastních komentářů, návrhů a hlasů. Aktivní prvky jsou dostupné pouze u norem v odpovídající otevřené fázi. Rozhraní srozumitelně vysvětlí, zda je akce nedostupná kvůli stavu normy, uzavřenému sběru nebo blokovanému účtu.

### 5.3 Administrátor

Administrátor má sekci „Moje normy“. Může v ní zakládat normy, nahrávat soubory, upravovat průvodní informace, otevírat a ukončovat sběr, vypořádávat připomínky a měnit stav pouze u norem, jejichž `ownerAdminId` odpovídá jeho uživatelskému ID. Cizí normy může vidět ve veřejné podobě, ale bez správcovských ovládacích prvků.

### 5.4 Superadministrátor

Superadministrátor má sekce „Všechny normy“ a „Uživatelé“. U norem má stejná oprávnění jako jejich vlastník bez ohledu na `ownerAdminId`.

Správa uživatelů používá schválený střídmý layout „tabulka + filtry + detail“:

- horní souhrn počtu aktivních, pozvaných a blokovaných účtů,
- vyhledávání podle jména, e-mailu, jednoty nebo členského ID,
- filtry role a stavu,
- tabulka s uživatelem, rolí, stavem a posledním přihlášením,
- detail vybraného uživatele v bočním panelu,
- samostatná akce „Vytvořit administrátora“,
- historie auditovaných změn v detailu.

Superadministrátor může účet zablokovat nebo aktivovat a měnit roli mezi členem a administrátorem. Aplikace nesmí dovolit zablokovat, degradovat ani smazat posledního aktivního superadministrátora. Dalšího superadministrátora lze založit nebo povýšit pouze z účtu superadministrátora.

Povýšení člena na administrátora zruší jeho aktivní relace a odešle do simulované schránky odkaz pro nastavení prvního správcovského hesla. Do jeho použití je účet ve stavu `invited`. Při převedení administrátora zpět na člena se zruší relace i správcovské heslo; další přihlášení proběhne členským jednorázovým kódem. Normy, které takový administrátor vlastní, musí superadministrátor před změnou role převést na jiného aktivního správce; bez převodu aplikace změnu odmítne.

## 6. Komponenty a odpovědnosti

Logika se oddělí od současné rozsáhlé stránky do menších jednotek s jasným rozhraním:

- `AuthService`: registrace člena, výzvy s kódem, přihlášení heslem, nastavení a obnova hesla, relace a odhlášení.
- `AccessControl`: jediný zdroj pravidel rolí, vlastnictví normy a stavových omezení.
- `UserStore`: uživatelské profily, role, stav účtu, ověření e-mailu a bezpečně odvozené heslo v režimu dema.
- `NormStore`: normy a vazba `ownerAdminId`; všechny změnové metody ověřují oprávnění přes `AccessControl`.
- `AuditStore`: append-only záznam významných přihlášení, změn rolí, blokací a administrativních zásahů.
- prezentační komponenty: přihlašovací dialog, registrace, simulovaná schránka, profil, seznam uživatelů, filtry a detail uživatele.

Uživatelské rozhraní nesmí rozhodovat o oprávnění samo. Může skrýt nedostupné ovládací prvky, ale každá změnová metoda služby musí oprávnění znovu ověřit.

## 7. Datový model

### `User`

- `id`, `email`, `firstName`, `lastName`,
- `sokolUnit`, `membershipId`,
- `role`: `member | admin | superadmin`,
- `status`: `invited | pending_verification | active | blocked`,
- `emailVerifiedAt`, `createdAt`, `lastLoginAt`,
- volitelně `passwordHash`, `passwordSalt`, `passwordUpdatedAt` pouze pro správce.

### `LoginChallenge`

- `id`, `userId`, `type`: `member_code | set_password | reset_password`,
- hash kódu nebo tokenu, `expiresAt`, `usedAt`, `failedAttempts`.

### `Session`

- `id`, `userId`, `createdAt`, `expiresAt`, `revokedAt`.

### `AuditEvent`

- `id`, `actorUserId`, `action`, `targetType`, `targetId`, `timestamp`,
- stručná metadata změny bez hesel, kódů a tokenů.

### Doplnění `Norm`

- `ownerAdminId`: administrátor, který normu založil,
- `visibilityMode`: v této etapě vždy `public-detail`.

## 8. Datové toky a chybové stavy

Při každé aktivní operaci aplikace načte relaci, zkontroluje platnost a stav účtu a následně vyhodnotí roli, vlastnictví normy a stav procesu. Neoprávněná akce se neprovede, zobrazí srozumitelnou zprávu a zapíše auditní událost bez citlivých údajů.

Řešené chybové stavy:

- duplicitní e-mail při registraci,
- neplatný, použitý nebo expirovaný kód či odkaz,
- překročení pěti pokusů o členský kód,
- chybné heslo nebo nesplněná pravidla nového hesla,
- expirovaná nebo zrušená relace,
- blokovaný účet,
- administrátor se pokusí změnit cizí normu,
- pokus odebrat posledního aktivního superadministrátora,
- poškozená nebo nekompatibilní lokální data.

Při nekompatibilních lokálních datech aplikace nabídne bezpečný návrat k ukázkovým datům, ale reset provede až po výslovném potvrzení uživatele.

## 9. Ukládání dat a hranice demoverze

Pilot používá `localStorage` pro uživatele, výzvy, relace, normy, příspěvky, hlasy a audit; soubory zůstávají v IndexedDB. Data jsou společná pouze v rámci jednoho profilu prohlížeče a nesdílejí se mezi zařízeními ani návštěvníky.

Na přihlašovací a administrativní obrazovce bude viditelné upozornění, že jde o lokální simulaci. Přestože demo odvozuje hesla pomocí Web Crypto, návštěvník ovládající prohlížeč může lokální data změnit. Produkční nasazení proto vyžaduje serverovou databázi, serverovou autorizaci, bezpečné hashování hesel, e-mailovou službu, omezení frekvence pokusů, ochranu proti CSRF/XSS, centrální audit a zálohování.

Navržené služby a datové typy vytvoří hranici, za kterou lze později dosadit API bez přepisování hlavních obrazovek a pravidel rolí.

## 10. Ověřovací scénáře

Implementace bude považována za funkční, pokud projdou alespoň tyto scénáře:

1. Veřejný návštěvník zobrazí seznam i detail normy, ale nemůže přidat komentář ani hlas.
2. Nový člen dokončí registraci platným kódem; neplatný, použitý a expirovaný kód je odmítnut.
3. Modelový člen se přihlásí e-mailem a kódem `260814` a může se účastnit otevřeného procesu.
4. Modelový administrátor se přihlásí heslem, spravuje vlastní normu a nemůže změnit normu jiného administrátora ani při ručně vyvolané akci.
5. Superadministrátor spravuje všechny normy, vytvoří administrátora a nový administrátor si přes simulovaný odkaz nastaví první heslo.
6. Správce si změní heslo a přihlášení starým heslem přestane fungovat.
7. Obnova zapomenutého hesla přijme platný jednorázový odkaz a odmítne jeho druhé použití.
8. Zablokování účtu ukončí jeho relaci a zabrání dalším aktivním akcím.
9. Systém zabrání odebrání nebo zablokování posledního aktivního superadministrátora.
10. Mobilní zobrazení zachová použitelnost registrace, přihlášení, tabulky uživatelů, detailu uživatele a správy vlastních norem.
11. Obnovení stránky zachová platnou relaci, zatímco po osmi hodinách nebo po odhlášení vyžaduje nové přihlášení.
12. Audit zachytí změny rolí, blokace, pokusy o neoprávněnou správu normy a dokončení či obnovu administrátorského hesla bez uložení tajných údajů.

## 11. Kritéria přijetí

- Tři role mají přesně oprávnění uvedená v tabulce a nelze jim přidávat individuální výjimky.
- Běžní uživatelé se sami registrují a přihlašují bez hesla prostřednictvím ověřeného e-mailu a jednorázového kódu.
- Administrátor a superadministrátor používají nastavitelné heslo a funkční simulaci prvního nastavení, změny a obnovy hesla.
- Administrátor může spravovat pouze normy, které založil; superadministrátor může spravovat všechny.
- Pouze superadministrátor vytváří administrátory a spravuje role a stavy účtů.
- Veřejný obsah zůstává transparentně dostupný bez přihlášení.
- Rozhraní je responzivní, střídmé a navazuje na existující grafický styl Sokola.
- Demoverze jasně komunikuje lokální charakter dat a není prezentována jako produkčně bezpečný systém.
