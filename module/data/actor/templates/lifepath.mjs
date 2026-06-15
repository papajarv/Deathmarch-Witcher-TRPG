/**
 * Lifepath template — character biographical / lifepath data.
 *
 * Schema shape (from docs/compatibility.md §2):
 *   gender                              string
 *   general.age                         number
 *   general.background                  HTML (backstory prose)
 *   general.homeland                    string
 *   general.reputation                  number or { value, modifiers }
 *   general.socialStanding              string
 *   general.personality                 string
 *   general.feelingsOnPeople            string
 *   general.details                     HTML (appearance / mannerisms)
 *   general.lifeEvents.{key}            arbitrary subfields per event
 *   lifepathModifiers.ignoredArmorEncumbrance   boolean
 *   logs.ipLog                          [{ label, value }]
 *   focus1..focus4                      string  (spell focus slots)
 *   notes                               HTML
 *
 * Reputation needs a value AND a modifiers list per overhaul-ui
 * statMixin.js:107 — `system.reputation.modifiers.forEach(mod => ...)`.
 */

const fields = foundry.data.fields;

export function lifepathSchema() {
    return {
        gender: new fields.StringField({ initial: "" }),

        general: new fields.SchemaField({
            age:            new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            background:     new fields.HTMLField({ initial: "" }),
            homeland:       new fields.StringField({ initial: "" }),
            reputation:     new fields.SchemaField({
                value:     new fields.NumberField({ initial: 0, integer: true }),
                modifiers: new fields.ArrayField(new fields.SchemaField({
                    name:  new fields.StringField({ initial: "" }),
                    value: new fields.NumberField({ initial: 0, integer: true })
                }))
            }),
            socialStanding: new fields.StringField({ initial: "" }),
            personality:    new fields.StringField({ initial: "" }),
            feelingsOnPeople: new fields.StringField({ initial: "" }),
            details:        new fields.HTMLField({ initial: "" }),
            lifeEvents:     new fields.ObjectField({ initial: {} })
        }),

        lifepathModifiers: new fields.SchemaField({
            ignoredArmorEncumbrance: new fields.BooleanField({ initial: false })
        }),

        logs: new fields.SchemaField({
            ipLog: new fields.ArrayField(new fields.SchemaField({
                label: new fields.StringField({ initial: "" }),
                value: new fields.NumberField({ initial: 0, integer: true })
            }))
        }),

        focus1: new fields.StringField({ initial: "" }),
        focus2: new fields.StringField({ initial: "" }),
        focus3: new fields.StringField({ initial: "" }),
        focus4: new fields.StringField({ initial: "" }),

        notes: new fields.HTMLField({ initial: "" })
    };
}
