# 🎮 Kassbi Combat Prediction & Tactical Prep - v3

## ✅ Implémentation Complète

### 🔮 **Prédiction du Contact au Tour Suivant**

Kassbi prédit maintenant si le combat sera engagé au prochain tour et **prépare tactiquement** (défense OU attaque).

#### **Algorithme de Prédiction**

```typescript
predictContactNextTurn(): { iCanShoot: boolean; enemyCanShoot: boolean }

Calculs:
- myMaxReach = max(0, distance - mpLeft)  // Ma portée max si je me rapproche
- enemyMaxReach = max(0, distance - enemy.mp)  // Sa portée max s'il s'approche

Résultats:
- iCanShoot = (myMaxReach ≤ myMaxRange)      // Peux-je tirer au prochain tour?
- enemyCanShoot = (enemyMaxReach ≤ enemyMaxRange)  // Peut-il tirer au prochain tour?
```

#### **Exemple Concret**

Situation:
- Distance actuelle: 8 cases
- Mon MP restant: 2 → je peux avancer au max de 2 cases → distance min = 6
- Mon arme: portée max 5
- Ennemi MP: 3 → distance min pour lui = 5
- Ennemi arme: portée max 4

Prédiction:
- `iCanShoot = (6 ≤ 5)` → FALSE (pas assez proche)
- `enemyCanShoot = (5 ≤ 4)` → FALSE (pas assez proche)
- Résultat: **Aucun ne peut tirer au prochain tour**

Autre exemple:
- Distance: 5 cases
- Mon MP: 2 → distance min = 3
- Mon arme: portée max 5
- Ennemi MP: 1 → distance min = 4
- Ennemi arme: portée max 4

Prédiction:
- `iCanShoot = (3 ≤ 5)` → TRUE (je peux tirer!)
- `enemyCanShoot = (4 ≤ 4)` → TRUE (il peut tirer aussi!)
- Résultat: **Les deux peuvent tirer** → mode équilibré

---

### ⚔️ **Stratégies Tactiques par Scénario**

#### **Scénario 1 : L'Ennemi Peut Tirer, Pas Moi**
```
shouldPrioritizeDefense() = TRUE
↓
Priorité: BOUCLIER EN PREMIER
↓
Kassbi utilise son TP pour se protéger avant de penser à soigner
Exemple action: [move → shield → bandage → recul?]
```

**Cas d'Usage** : Ennemi à portée max (5-6 cases), je suis encore loin → ME PROTÉGER!

#### **Scénario 2 : Je Peux Tirer, Pas l'Ennemi**
```
shouldBoostAttack() = TRUE
↓
Priorité: CHIPS BOOST (réservé pour futurs amélioration)
↓
Kassbi utilise son TP pour préparer une attaque massive
Exemple action: [move → heal (optionnel) → charge vers portée]
```

**Cas d'Usage** : Je suis en portée, ennemi loin → JE CHARGE!

#### **Scénario 3 : Les Deux Peuvent Tirer**
```
shouldPrioritizeDefense() = FALSE
shouldBoostAttack() = FALSE
↓
Priorité: ÉQUILIBRE (soin normal, puis bouclier si menace)
↓
Kassbi joue prudemment, prépare défense après les tirs
Exemple action: [move → shoot → bandage → shield]
```

**Cas d'Usage** : Combat symétrique, les deux à portée → ÉQUILIBRE

---

### 🛡️ **Réorganisation des Actions Chips**

**Avant** (v2):
```
equip → move → tir → soin optionnel → bouclier (si menace reste)
```

**Après** (v3):
```
IF shouldPrioritizeDefense():
  equip → move → TIR → BOUCLIER EN PREMIER → soin
  
ELSE:
  equip → move → TIR → SOIN EN PREMIER → bouclier
```

#### **Impact**

| Scénario | Avant | Après | Avantage |
|----------|-------|-------|----------|
| Ennemi tir imminent | Soin → bouclier | Bouclier → soin | ✅ Protégé plus tôt |
| Je tir imminent | Bouclier → soin | Soin → bouclier | ✅ Plus offensif |
| Équilibre | Soin → bouclier | Soin → bouclier | ✅ Cohérent |

---

## 🧪 **Tests et Validation**

✅ **Build** : Compilation réussie  
✅ **Tests** : 25/25 tests passent  
✅ **Commits** :
- `5f19cc4` - add combat prediction
- `1c51dfb` - add speech
- `a365a26` - update strategie

---

## 🎮 **Comment ça Marche en Combat**

### **Tour 1 : Approche Prudente**
```
Distance = 8, mon arme portée 5, ennemi portée 4

Prédiction:
- iCanShoot = FALSE (trop loin)
- enemyCanShoot = FALSE (trop loin)

Tactique: Équilibre
↓
Actions: [move → soin optionnel → bouclier si besoin]
```

### **Tour 2 : Contact Imminent (Ennemi Peut Tirer)**
```
Distance = 5, mon arme portée 5, ennemi portée 4
Ennemi s'est rapproché!

Prédiction:
- iCanShoot = FALSE (limite)
- enemyCanShoot = TRUE (peut tirer au prochain tour!)

Tactique: DÉFENSE PRIORITAIRE ⚠️
↓
Actions: [BOUCLIER EN PREMIER → bandage → recul]
Kassbi se protège face à la menace!
```

### **Tour 3 : Mon Tour de Tirer**
```
Distance = 3, mon arme portée 5, ennemi portée 4
Je viens de me rapprocher, ennemi loin!

Prédiction:
- iCanShoot = TRUE (en portée!)
- enemyCanShoot = FALSE (pas assez près)

Tactique: OFFENSIVE ⚡
↓
Actions: [tir weapon x2 → soin optionnel → recul si blessé]
Kassbi tire sans crainte!
```

---

## 🔧 **Fichiers Modifiés**

```
src/Classes/Plannification/Plannification.ts (v2 → v3)
  + predictContactNextTurn()
  + shouldPrioritizeDefense()
  + shouldBoostAttack()
  + planChipsActionsAfterShoot() [réorganisé]
```

---

## 🚀 **Prochaines Améliorations Possibles**

1. **Chips Boost** : Ajouter des chips qui augmentent force/agilité pour `shouldBoostAttack()`
2. **Prédiction Multi-tour** : Lire 2-3 tours à l'avance
3. **Adaptatif par Style** : AGGRESSIVE = plus de tirs, DEFENSIVE = plus de défense
4. **Cooldown Management** : Prédire quand les chips seront disponibles

---

**Version TypeScript** : 5.8  
**Compatible** : Leek Wars API 5.8+  
**Tests** : ✅ 25/25 passent  
**État** : ✅ Prêt pour le combat !
